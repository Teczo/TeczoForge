"""FRG-58: test Baidu Unlimited-OCR on System 1.

This is a test script only. It is not part of the app.
Run it with the separate OCR venv, never with ComfyUI's Python.

One run = one model load + one OCR job. It prints and saves:
  - cold load time (model from disk to GPU)
  - seconds per page
  - peak VRAM (torch.cuda.max_memory_allocated and nvidia-smi)
  - the raw model output, with the <|det|> layout tags kept

Examples (Command Prompt):
  python run_test.py --model C:\\AI-Models\\Unlimited-OCR --out C:\\OCR\\out --mode gundam --input doc.pdf --page 1
  python run_test.py --model C:\\AI-Models\\Unlimited-OCR --out C:\\OCR\\out --mode base   --input page.png
  python run_test.py --model C:\\AI-Models\\Unlimited-OCR --out C:\\OCR\\out --mode multi  --input doc.pdf --max-pages 5
"""

import argparse
import json
import os
import subprocess
import sys
import threading
import time

# Never touch the network. The model must come from the local folder only.
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"

import fitz  # PyMuPDF
import torch
from transformers import AutoModel, AutoTokenizer

# Settings from the model page.
SINGLE_PROMPT = "<image>document parsing."
MULTI_PROMPT = "<image>Multi page parsing."
MAX_LENGTH = 32768
NO_REPEAT_NGRAM = 35
NGRAM_WINDOW_SINGLE = 128
NGRAM_WINDOW_MULTI = 1024
PDF_DPI = 300
# Some test PDFs have very large pages (long well-log strips). At 300 dpi they
# would become huge PNGs, so the dpi is lowered until a page fits this limit.
MAX_PAGE_PIXELS = 40_000_000


class NvidiaSmiPeak:
    """Polls nvidia-smi in a thread and keeps the highest 'memory.used' (MiB) seen."""

    def __init__(self, interval=0.25):
        self.interval = interval
        self.peak_mib = 0
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _read(self):
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
            capture_output=True, text=True,
        ).stdout
        return int(out.strip().splitlines()[0])

    def _run(self):
        while not self._stop.is_set():
            try:
                self.peak_mib = max(self.peak_mib, self._read())
            except Exception:
                pass
            time.sleep(self.interval)

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._stop.set()
        self._thread.join()


def pdf_pages_to_png(pdf_path, out_dir, first_page, last_page):
    """Render PDF pages (1-based, inclusive) to PNG files. Returns paths and the dpi used per page."""
    os.makedirs(out_dir, exist_ok=True)
    doc = fitz.open(pdf_path)
    paths, dpis = [], []
    last_page = min(last_page, doc.page_count)
    for number in range(first_page, last_page + 1):
        page = doc[number - 1]
        dpi = PDF_DPI
        while (page.rect.width * dpi / 72) * (page.rect.height * dpi / 72) > MAX_PAGE_PIXELS:
            dpi -= 25
        pix = page.get_pixmap(matrix=fitz.Matrix(dpi / 72, dpi / 72))
        path = os.path.join(out_dir, f"page_{number:04d}.png")
        pix.save(path)
        paths.append(path)
        dpis.append(dpi)
    doc.close()
    return paths, dpis


def load_model(model_dir):
    torch.cuda.synchronize()
    start = time.perf_counter()
    tokenizer = AutoTokenizer.from_pretrained(model_dir, trust_remote_code=True, local_files_only=True)
    model = AutoModel.from_pretrained(
        model_dir,
        trust_remote_code=True,
        local_files_only=True,
        use_safetensors=True,
        torch_dtype=torch.bfloat16,
    )
    model = model.eval().cuda()
    torch.cuda.synchronize()
    return tokenizer, model, time.perf_counter() - start


def main():
    parser = argparse.ArgumentParser(description="FRG-58 Unlimited-OCR test")
    parser.add_argument("--model", required=True, help="local model folder")
    parser.add_argument("--out", required=True, help="output folder (outside the repo)")
    parser.add_argument("--mode", required=True, choices=["gundam", "base", "multi"])
    parser.add_argument("--input", required=True, help="an image, or a PDF")
    parser.add_argument("--page", type=int, default=1, help="PDF page for gundam/base (1-based)")
    parser.add_argument("--max-pages", type=int, default=5, help="PDF pages for multi mode")
    parser.add_argument("--name", default="", help="short label for the result files")
    args = parser.parse_args()

    name = args.name or os.path.splitext(os.path.basename(args.input))[0][:40]
    run_id = f"{name}-{args.mode}"
    run_dir = os.path.join(args.out, run_id)
    os.makedirs(run_dir, exist_ok=True)

    # 1. Turn the input into page images.
    is_pdf = args.input.lower().endswith(".pdf")
    if is_pdf and args.mode == "multi":
        pages, dpis = pdf_pages_to_png(args.input, os.path.join(run_dir, "pages"), 1, args.max_pages)
    elif is_pdf:
        pages, dpis = pdf_pages_to_png(args.input, os.path.join(run_dir, "pages"), args.page, args.page)
    else:
        pages, dpis = [args.input], [None]

    # 2. Cold load.
    torch.cuda.reset_peak_memory_stats()
    with NvidiaSmiPeak() as load_smi:
        tokenizer, model, load_seconds = load_model(args.model)
    load_vram_gib = torch.cuda.max_memory_allocated() / 2**30
    print(f"[load] {load_seconds:.1f} s, torch peak {load_vram_gib:.2f} GiB, nvidia-smi peak {load_smi.peak_mib} MiB")

    # 3. OCR. save_results stays False: the model code runs eval() on its own
    #    output when saving, and writes extra files. We save the raw text ourselves.
    torch.cuda.reset_peak_memory_stats()
    with NvidiaSmiPeak() as run_smi:
        torch.cuda.synchronize()
        start = time.perf_counter()
        if args.mode == "multi":
            raw, _ = model.infer_multi(
                tokenizer,
                prompt=MULTI_PROMPT,
                image_files=pages,
                output_path=os.path.join(run_dir, "model-out"),
                image_size=1024,
                max_length=MAX_LENGTH,
                no_repeat_ngram_size=NO_REPEAT_NGRAM,
                ngram_window=NGRAM_WINDOW_MULTI,
                save_results=False,
            )
        else:
            gundam = args.mode == "gundam"
            raw = model.infer(
                tokenizer,
                prompt=SINGLE_PROMPT,
                image_file=pages[0],
                output_path=os.path.join(run_dir, "model-out"),
                base_size=1024,
                image_size=640 if gundam else 1024,
                crop_mode=gundam,
                max_length=MAX_LENGTH,
                no_repeat_ngram_size=NO_REPEAT_NGRAM,
                ngram_window=NGRAM_WINDOW_SINGLE,
                eval_mode=True,  # returns the raw text, no streaming, no files
            )
        torch.cuda.synchronize()
        run_seconds = time.perf_counter() - start
    run_vram_gib = torch.cuda.max_memory_allocated() / 2**30

    output_tokens = len(tokenizer.encode(raw, add_special_tokens=False))
    result = {
        "run": run_id,
        "input": os.path.basename(args.input),
        "mode": args.mode,
        "pages": len(pages),
        "dpi": dpis,
        "cold_load_s": round(load_seconds, 1),
        "load_vram_torch_gib": round(load_vram_gib, 2),
        "load_vram_smi_mib": load_smi.peak_mib,
        "run_s": round(run_seconds, 1),
        "s_per_page": round(run_seconds / len(pages), 1),
        "output_tokens": output_tokens,
        "tokens_per_s": round(output_tokens / run_seconds, 1) if run_seconds else None,
        "peak_vram_torch_gib": round(run_vram_gib, 2),
        "peak_vram_smi_mib": run_smi.peak_mib,
        "hit_max_length": output_tokens >= MAX_LENGTH - 100,
    }

    with open(os.path.join(run_dir, "raw.md"), "w", encoding="utf-8") as f:
        f.write(raw)
    with open(os.path.join(args.out, "results.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(result) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    sys.exit(main())
