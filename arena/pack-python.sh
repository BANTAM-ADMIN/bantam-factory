#!/usr/bin/env bash
# pack-python.sh — rebuild the container's portable python artifact, and VERIFY.
#
# Poka-yoke for a fix that was almost invisible: python.tar.gz was hand-built
# once and never had a packer, so the packages inside it were folklore. On
# 2026-08-20 chess-best-move — a task whose whole job is reading a PNG — could
# not open one, because the task image ships Pillow on /usr/bin/python3 while
# the adapter symlinks python3 at THIS tarball, which had numpy and no PIL. A
# tool the model reaches for to do its job must be PROVIDED, not steered away
# from; that is the third scar in this family (see bantam_agent.py's pip and
# python3.11 notes). Regenerating the tarball by hand would silently undo it.
#
# RUN THIS instead of rebuilding python.tar.gz by hand.
set -euo pipefail

TB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Every package the bench has actually needed from the portable python. Each one
# is here because a run REACHED for it and our wiring said no:
#   numpy  - reference computation
#   PIL    - chess-best-move could not open the PNG its whole task was about
#   scipy  - raman-fitting needed curve_fit, hand-rolled a grid search instead,
#            and returned wrong peak values; largest-eigenval reached for it too
REQUIRED_IMPORTS=(numpy PIL scipy)

[ -f "$TB/python.tar.gz" ] || { echo "FATAL: $TB/python.tar.gz missing — nothing to rebuild from"; exit 1; }

echo "unpacking current artifact…"
tar xzf "$TB/python.tar.gz" -C "$WORK"
PY="$WORK/python/bin/python3"
[ -x "$PY" ] || { echo "FATAL: no python3 at $PY"; exit 1; }
echo "  $("$PY" --version)"

echo "ensuring required packages…"
for pkg in numpy pillow scipy; do
  "$PY" -m pip install --quiet --no-cache-dir --upgrade "$pkg"
done

echo "verifying imports…"
for mod in "${REQUIRED_IMPORTS[@]}"; do
  "$PY" -c "import $mod" || { echo "FATAL: $mod does not import after install"; exit 1; }
done
"$PY" -c "import numpy, PIL, scipy; from PIL import Image, ImageDraw, ImageFont; from scipy.optimize import curve_fit; print('  numpy', numpy.__version__, '/ PIL', PIL.__version__, '/ scipy', scipy.__version__)"

echo "repacking…"
cp "$TB/python.tar.gz" "$TB/python.tar.gz.prev"
( cd "$WORK" && tar czf "$TB/python.tar.gz.new" python )
mv "$TB/python.tar.gz.new" "$TB/python.tar.gz"

# RELOCATION is the real contract: the adapter untars this to /opt/python inside
# a container that never saw the build path. A tarball that imports here and
# dies there is the failure this check exists to catch.
echo "verifying RELOCATION into a task container…"
docker run --rm -v "$TB/python.tar.gz:/tmp/p.tgz:ro" ubuntu:24.04 sh -c '
  mkdir -p /opt/python && tar xzf /tmp/p.tgz -C /opt/python --strip-components=1 &&
  ln -sf /opt/python/bin/python3 /usr/local/bin/python3 &&
  python3 -c "import numpy, PIL, scipy; from PIL import Image, ImageFont; from scipy.optimize import curve_fit; print(\"  relocated OK: numpy\", numpy.__version__, \"/ PIL\", PIL.__version__, \"/ scipy\", scipy.__version__)"
' || { echo "FATAL: relocation check failed — restoring previous artifact"; mv "$TB/python.tar.gz.prev" "$TB/python.tar.gz"; exit 1; }

echo "packed $(stat -c%s "$TB/python.tar.gz") bytes — previous kept at python.tar.gz.prev"
