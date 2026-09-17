#!/usr/bin/env python3
"""Local llama.cpp -> ComfyUI Krea 2 image bridge.

The llama server must be started with --sleep-idle-seconds so its model leaves
VRAM between turns. ComfyUI is addressed through its local HTTP API.
"""

from __future__ import annotations

import argparse
import base64
import json
import secrets
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path


LLAMA = "http://127.0.0.1:8085"
COMFY = "http://127.0.0.1:8188"
OUTPUT_NODE = "9"
MODEL = "krea2_turbo_fp8_scaled.safetensors"
TEXT_ENCODER = "qwen3vl_4b_fp8_scaled.safetensors"
VAE = "qwen_image_vae.safetensors"


def request(base: str, path: str, method: str = "GET", payload=None, timeout=30):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(
        base.rstrip("/") + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if data else {},
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        raw = response.read()
    return json.loads(raw) if raw else None


def wait_for(predicate, description: str, timeout: float):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            result = predicate()
            if result:
                return result
        except (OSError, ValueError, json.JSONDecodeError):
            pass
        time.sleep(1)
    raise TimeoutError(f"timed out waiting for {description}")


def llama_sleeping() -> bool:
    return request(LLAMA, "/props", timeout=3).get("is_sleeping") is True


def ask_llama(text: str) -> dict:
    system = (
        "You are an image-prompt planner. Return JSON only with exactly these keys: "
        "prompt, negative_prompt, width, height. Turn the user's request into a vivid "
        "Krea 2 prompt. width and height must be multiples of 8 between 512 and 1536."
    )
    body = {
        "model": "local",
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": text}],
        "temperature": 0.8,
        "max_tokens": 700,
        "stream": False,
    }
    result = request(LLAMA, "/v1/chat/completions", "POST", body, timeout=600)
    content = result["choices"][0]["message"]["content"]
    start, end = content.find("{"), content.rfind("}")
    if start < 0 or end < start:
        raise ValueError(f"llama returned non-JSON prompt: {content[:300]!r}")
    plan = json.loads(content[start : end + 1])
    plan["width"] = max(512, min(1536, int(plan["width"]) // 8 * 8))
    plan["height"] = max(512, min(1536, int(plan["height"]) // 8 * 8))
    return plan


def workflow(plan: dict, seed: int) -> dict:
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": MODEL, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": TEXT_ENCODER, "type": "krea2", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": plan["prompt"], "clip": ["2", 0]}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"text": plan.get("negative_prompt", ""), "clip": ["2", 0]}},
        "6": {"class_type": "EmptySD3LatentImage", "inputs": {"width": plan["width"], "height": plan["height"], "batch_size": 1}},
        "7": {"class_type": "KSampler", "inputs": {"model": ["1", 0], "seed": seed, "steps": 28, "cfg": 4.0, "sampler_name": "euler", "scheduler": "simple", "positive": ["4", 0], "negative": ["5", 0], "latent_image": ["6", 0], "denoise": 1.0}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
        OUTPUT_NODE: {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": "BantamKrea2"}},
    }


def generate(plan: dict, seed: int) -> Path:
    request(COMFY, "/free", "POST", {"unload_models": True, "free_memory": True})
    payload = {"prompt": workflow(plan, seed), "client_id": secrets.token_hex(8)}
    queued = request(COMFY, "/prompt", "POST", payload)
    prompt_id = queued["prompt_id"]

    def finished():
        history = request(COMFY, f"/history/{prompt_id}", timeout=5)
        return history.get(prompt_id, {}).get("outputs", {}).get(OUTPUT_NODE)

    output = wait_for(finished, "ComfyUI image generation", 1800)
    images = output.get("images", [])
    if not images:
        raise RuntimeError("ComfyUI completed without an image output")
    image = images[0]
    query = urllib.parse.urlencode({k: image[k] for k in ("filename", "subfolder", "type")})
    destination = Path.cwd() / image["filename"]
    with urllib.request.urlopen(f"{COMFY}/view?{query}", timeout=60) as response:
        destination.write_bytes(response.read())
    return destination


def report_to_llama(user_text: str, image: Path) -> str:
    encoded = base64.b64encode(image.read_bytes()).decode("ascii")
    body = {
        "model": "local",
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": f"The image requested below is finished. Briefly tell me it is done and mention one notable detail. Request: {user_text}"},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{encoded}"}},
            ],
        }],
        "temperature": 0.7,
        "max_tokens": 180,
        "stream": False,
    }
    result = request(LLAMA, "/v1/chat/completions", "POST", body, timeout=600)
    return result["choices"][0]["message"]["content"].strip()


def run_once(user_text: str, timeout: float) -> Path:
    print("Asking llama.cpp for an image plan…", flush=True)
    plan = ask_llama(user_text)
    print(json.dumps(plan, indent=2), flush=True)
    print("Waiting for llama.cpp to move its model out of VRAM…", flush=True)
    wait_for(llama_sleeping, "llama.cpp sleep (/props is_sleeping=true)", timeout)
    print("Generating with Krea 2…", flush=True)
    image = generate(plan, secrets.randbelow(2**63))
    print(f"Image saved to {image}", flush=True)
    request(COMFY, "/free", "POST", {"unload_models": True, "free_memory": True})
    print("Returning the image to llama.cpp…", flush=True)
    reply = report_to_llama(user_text, image)
    wait_for(lambda: not llama_sleeping(), "llama.cpp to return to VRAM", 10)
    print(f"llama.cpp: {reply}", flush=True)
    return image


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("request", nargs="?", help="image request; omit for interactive mode")
    parser.add_argument("--wait", type=float, default=360, help="seconds to wait for llama.cpp to sleep")
    parser.add_argument("--dry-run", action="store_true", help="print the Krea 2 workflow without calling either server")
    args = parser.parse_args()
    text = args.request
    if args.dry_run:
        text = text or "test image"
        print(json.dumps(workflow({"prompt": text, "negative_prompt": "", "width": 1024, "height": 1024}, 1), indent=2))
        return 0
    if not text:
        while True:
            try:
                text = input("Image request (Ctrl-D to quit): ").strip()
            except EOFError:
                return 0
            if not text:
                continue
            try:
                run_once(text, args.wait)
            except (OSError, TimeoutError, KeyError, TypeError, ValueError, RuntimeError) as exc:
                print(f"bridge failed: {exc}", file=sys.stderr)
            text = None
    try:
        run_once(text, args.wait)
    except (OSError, TimeoutError, KeyError, TypeError, ValueError, RuntimeError) as exc:
        print(f"bridge failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
