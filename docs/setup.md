# LucidScan: setup and CI notes for `main`

These notes describe the code on `main` (the Flask server and Chrome-side scripts). Back to the [README](../README.md).

## Tech

- Python 3.11+, Flask and Flask-CORS for the local `/detect` server
- PyTorch and Hugging Face Transformers: `desklib/ai-text-detector-v1.01` for text, CLIP (`openai/clip-vit-large-patch14`) and ViT (`google/vit-large-patch32-224-in21k`) for images and video
- OpenCV, Pillow, piexif, and invisible-watermark for the image checks
- Gradio for the optional `detect.py --gui` page
- JavaScript Chrome extension scripts (context menus and popup)

## Setup

With [uv](https://docs.astral.sh/uv/) (the project is set up for it in `pyproject.toml`):

```sh
uv sync
```

Or with pip:

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install torch torchvision torchaudio   # pick the build for your hardware
pip install -r requirements.txt
```

`pyproject.toml` points torch at the CUDA 12.6 wheel index on Windows and Linux. `requirements.txt` was generated with `uv pip compile` and leaves the torch lines commented out, so install torch first. The models download from Hugging Face on first run.

## Running

`server.py` calls `app.run(port=5000, debug=True)` when executed as a script:

```sh
python server.py
```

`detect.py` accepts `--image`, `--video`, or `--gui`. With no flag it prints: use `--image`, `--video`, or `--gui`. `--gui` opens a Gradio page.

```sh
python detect.py --image path/to/image.png
python detect.py --gui
```

`text_detection.py` scores two example strings when executed as a script.

## CI

There are no tests on `main`, so `.github/workflows/ci.yml` byte-compiles the Python files and runs `node --check` on the extension's JavaScript as a syntax smoke check.
