"""Keep a bounded set of GGUF files mapped and warm without copying weights."""
import argparse
import json
import mmap
import os
import socket
from collections import OrderedDict


def serve(socket_path):
    entries = OrderedDict()
    listener = socket.socket(socket.AF_UNIX)
    listener.bind(socket_path)
    os.chmod(socket_path, 0o600)
    listener.listen(8)

    def drop(key):
        entry = entries.pop(key, None)
        if entry:
            for handle, mapping in entry['maps']:
                mapping.close()
                os.posix_fadvise(handle.fileno(), 0, 0, os.POSIX_FADV_DONTNEED)
                handle.close()

    try:
        while True:
            client, _ = listener.accept()
            with client, client.makefile('rwb') as stream:
                try:
                    request = json.loads(stream.readline(65536))
                    operation = request['op']
                    if operation == 'drop':
                        drop(request['key'])
                    elif operation == 'activate':
                        # Stop reserving the mapping, leaving the file cache hot
                        # for the model server which is about to read these files.
                        entry = entries.pop(request['key'], None)
                        if entry:
                            for handle, mapping in entry['maps']:
                                mapping.close()
                                handle.close()
                    elif operation == 'cache':
                        key = request['key']
                        files = request['files']
                        size = sum(os.stat(name).st_size for name in files)
                        maximum = request['maxBytes']
                        if request['maxEntries'] < 1:
                            raise ValueError('RAM standby count must be positive for caching')
                        if size > maximum:
                            raise ValueError('model exceeds the RAM standby budget')
                        drop(key)
                        while entries and (len(entries) >= request['maxEntries'] or sum(e['bytes'] for e in entries.values()) + size > maximum):
                            drop(next(iter(entries)))
                        maps = []
                        try:
                            for name in files:
                                handle = open(name, 'rb')
                                mapping = mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ)
                                maps.append((handle, mapping))
                                mapping.madvise(mmap.MADV_WILLNEED)
                                for offset in range(0, len(mapping), mmap.PAGESIZE):
                                    mapping[offset]
                            entries[key] = {'bytes': size, 'files': files, 'maps': maps}
                        except Exception:
                            for handle, mapping in maps:
                                mapping.close()
                                handle.close()
                            raise
                    elif operation != 'status':
                        raise ValueError('unknown cache operation')
                    response = {'ok': True, 'entries': [{'key': key, 'bytes': value['bytes'], 'files': value['files']} for key, value in entries.items()]}
                except Exception as error:
                    response = {'ok': False, 'error': str(error)}
                stream.write(json.dumps(response).encode() + b'\n')
                stream.flush()
    finally:
        for key in list(entries):
            drop(key)
        listener.close()
        os.unlink(socket_path)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--socket', required=True)
    parser.add_argument('--request')
    args = parser.parse_args()
    if args.request:
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(120)
            client.connect(args.socket)
            client.sendall(args.request.encode() + b'\n')
            with client.makefile('rb') as stream:
                print(stream.readline().decode(), end='')
    else:
        serve(args.socket)
