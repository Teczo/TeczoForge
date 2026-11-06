# OCR test: Baidu Unlimited-OCR on System 1 (FRG-58)

Test only. Nothing in the app changed. Tested on 2026-10-17.

## Short answer

- It installs, loads and runs on System 1 in its own Python venv. Load is about 3.5 s, VRAM is 7-16 GB.
- Quality is very good on normal text pages and tables, near word-perfect.
- Quality is bad on our well-log prints. The model cannot read text turned 90 degrees (log headers),
  and it loses the tiny text along log tracks. On two pages it got stuck repeating itself
  (one page ran for 27 minutes, and a 20-page run spent 36 minutes looping on page 1 and never reached page 2).
- It can NOT run inside ComfyUI's Python today: the model code does not load with ComfyUI's transformers 5.17.
- Recommendation: **C, do not add it now.** See the end of this file.

## Model

| Item | Value |
|---|---|
| Model | `baidu/Unlimited-OCR`, 3B, BF16, MIT licence |
| Folder | `C:\AI-Models\Unlimited-OCR` (downloaded by Jaya) |
| Revision (commit) | `8249d20b2822a7d8a4c22c8d8c9069b5ac36bda3` (from `.cache\huggingface\download\*.metadata`) |
| Weights | `model-00001-of-000001.safetensors`, 6.67 GB. `model.safetensors` is a second copy with the same 2,710 tensors, so 6.67 GB of the folder is a duplicate. |

### What the model's own Python code does (read once)

Files: `modeling_unlimitedocr.py`, `modeling_deepseekv2.py`, `deepencoder.py`, `configuration_deepseek_v2.py`, `conversation.py`.

- Network: none. `import requests` is at the top of `modeling_unlimitedocr.py`, but it is never used.
  No download calls. `deepencoder.py` has a `torch.load(checkpoint)` path, but it is only used when a
  checkpoint path is passed, and the model never passes one.
- Files it writes: `infer()` and `infer_multi()` always create `output_path` and `output_path/images`.
  With `save_results=True` they also write `result.md`, `result_with_boxes*.jpg`, cropped images and
  sometimes `geo.jpg`, all inside `output_path`. Nothing outside it.
- Risk: with `save_results=True` the code runs Python `eval()` on the model's own output text
  (box lists, and a "geometry" mode). A document with crafted text could make the model output code
  that then runs. Our test script never uses `save_results=True`. It uses `eval_mode=True`
  (single page) or reads the return value (multi page), and saves the raw text itself.
- Outside the output folder, transformers itself copies the model `.py` files to
  `%USERPROFILE%\.cache\huggingface\modules\transformers_modules\`. That is how `trust_remote_code` works.
- `trust_remote_code=True` is required: this code runs inside our Python process.

## Install steps (what was done)

The venv is outside the repo and outside ComfyUI. Python 3.12.10 (installed by Jaya).

```bat
py -3.12 -m venv C:\Users\TeczoUser\Documents\GitHub\Teczo-AI\OCR\ocr-test
set V=C:\Users\TeczoUser\Documents\GitHub\Teczo-AI\OCR\ocr-test\Scripts\python.exe
%V% -m pip install --upgrade pip
%V% -m pip install torch==2.10.0 torchvision==0.25.0 --index-url https://download.pytorch.org/whl/cu128
%V% -m pip install transformers==4.57.1 Pillow==12.1.1 matplotlib==3.10.8 einops==0.8.2 addict==2.4.0 easydict==1.13 pymupdf==1.27.2.2 psutil==7.2.2
```

- The CUDA 12.8 build of torch is needed for the RTX 5090 (it lists `sm_120`).
- It worked on the first try. No flash-attention, no vLLM, no SGLang.
- Warnings that are safe to ignore: "position_ids newly initialized", "attention mask not set",
  "`max_new_tokens` and `max_length` both set".

## How the test was run

Script: `scripts/ocr-test/run_test.py`. One run = one model load + one OCR job.
It loads with `local_files_only=True` and sets `HF_HUB_OFFLINE=1`, so it never goes online.

- gundam = one page, `base_size=1024, image_size=640, crop_mode=True`, `ngram_window=128`
- base = one page, `image_size=1024, crop_mode=False`, `ngram_window=128`
- multi = several PDF pages in one call, `infer_multi(image_size=1024)`, `ngram_window=1024`
- All runs: `max_length=32768`, `no_repeat_ngram_size=35`, prompt `<image>document parsing.` or `<image>Multi page parsing.`
- PDF pages were turned into PNG at 300 dpi with PyMuPDF.

Quality was measured against the PDF's own text layer (all test PDFs are digital, with a text layer):
"recall" = share of the PDF's words that the OCR found, "precision" = share of OCR words that are real.
Then I looked at the output by eye.

## Results

The client documents are named Doc A-E here. Their output stays outside the repo, in `OCR\ocr-test-out\`.

| Run | Document | Mode | Pages | Time / page | Output tokens | Tokens / s | Peak VRAM torch | Peak VRAM nvidia-smi | Recall / precision |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Public sample, p1 (text) | gundam | 1 | 10.3 s | 375 | 36 | 8.52 GiB | 12.7 GB | 1.00 / 1.00 |
| 2 | Public sample, p2 (2 tables) | base | 1 | 9.7 s | 446 | 46 | 6.77 GiB | 8.6 GB | 0.98 / 0.99 |
| 3 | Public sample, p2 (2 tables) | gundam | 1 | 12.1 s | 446 | 37 | 8.52 GiB | 12.7 GB | 0.98 / 0.99 |
| 4 | Public sample, p3 (drawing) | gundam | 1 | 4.8 s | 156 | 33 | 8.52 GiB | 12.7 GB | 0.61 / 1.00 |
| 5 | Public sample, all | multi | 3 | 7.4 s | 1,002 | 45 | 6.99 GiB | 9.0 GB | 0.93 / 1.00 |
| 6 | Doc A: log print, 1 page | gundam | 1 | 30.4 s | 1,176 | 39 | 8.52 GiB | 12.7 GB | 0.66 / 1.00 |
| 7 | Doc B: log header page (rotated text) | base | 1 | **1,621 s** | 32,766 (limit) | 20 | 6.77 GiB | 9.1 GB | 0.16 / 0.01 |
| 8 | Doc B: same page | gundam | 1 | 251 s | 8,887 | 35 | 7.54 GiB | 10.5 GB | 0.11 / 0.05 |
| 9 | Doc C: caliper log, dense tracks | multi | 5 | 72.2 s | 11,385 | 32 | 7.43 GiB | 9.3 GB | 0.18 / 0.36 |
| 10 | Doc D: logging programme (text report) | multi | 10 | 34.6 s | 10,200 | 30 | 8.52 GiB | 11.6 GB | 0.92 / 0.94 |
| 11 | Doc E: coring report, p1 (rotated header) | gundam | 1 | 6.6 s | 254 | 38 | 7.54 GiB | 10.5 GB | 0.02 / 0.16 |
| 12 | Doc E: coring report, pages 1-20 | multi | 20 | **109 s** (2,183 s total) | 32,768 (limit) | 15 | 10.72 GiB | 16.4 GB | 0.04 / 0.03 |

Cold load (disk to GPU, in a new process): **3.4-3.8 s** every run, 6.31 GiB in torch, about 7.9 GB in nvidia-smi.
System 1 has 128 GB RAM, so Windows had the weights file in its file cache after the first run.
The very first load after a reboot will be slower (not measured).

nvidia-smi numbers include about 0.8 GB used by the desktop, and memory torch keeps cached.
Gundam mode uses about 2 GB more than base mode. Every run fits easily in the 32 GB of the RTX 5090,
but next to a running ComfyUI video job (which can use most of the card) it would not.

Speed is limited by the CPU side of generation: GPU use stayed around 15-20 %.
Time per page is set by how much text there is: about 30-45 tokens per second.

### Quality notes per document

- **Public sample p1 (text):** word-perfect. Headings and numbered lists found, layout boxes correct.
- **Public sample p2 (tables):** both tables come back as clean HTML `<table>`, every cell right.
  Only change: "m³" became "m3". Base and gundam gave the same result; base was faster and used less VRAM.
- **Public sample p3 (drawing):** title, caption, legend and sign-off read well. The drawing itself comes
  back as one `image` box with no text, so the labels inside it (tank, pump, valve names) are lost.
- **Public sample, multi-page:** same quality as the single pages, one `<PAGE>` marker per page.
  Saved as `docs/ocr-sample-raw.md`.
- **Doc A (log print):** what it read was right (precision 1.00), but it skipped about a third of the
  words: the small labels and numbers on the log tracks.
- **Doc B (log header, text turned 90 degrees):** failed in both modes. Base mode made up a table and
  repeated it until the 32,768-token limit (27 minutes for one page). Gundam mode repeated one line 394
  times. Even the normal, horizontal text lower on the page was lost.
- **Doc C (caliper log):** poor. It found under a fifth of the words. The pages are full of tiny track
  numbers that do not survive the 1024 x 1024 view that multi-page mode uses.
- **Doc D (text report, 10 pages):** good. Text, headings and tables read well in one pass.
- **Doc E p1 (rotated header):** failed. It made up a table with one word repeated.
- **Doc E, 20 pages:** failed badly. The model looped on page 1 (the rotated header) for 36 minutes until it hit the 32,768-token limit, and never reached page 2. One bad page ruins the whole multi-page call. This was also the highest VRAM seen (16.4 GB in nvidia-smi), and generation slowed to 15 tokens per second.

In short: the model is strong on normal upright documents and tables, and weak on our well-log
prints. Rotated text is the biggest problem, and it can make the model loop for many minutes.

### What was not tested

- No real scan and no phone photo: all five test documents are digital PDFs with a text layer.
  For those, PyMuPDF can already pull the exact text with no OCR at all.
- No very long run (100+ pages in one call). The longest was 20 pages.

## Can it run inside ComfyUI?

ComfyUI: `C:\AI\ComfyUI_windows_portable`, its own Python in `python_embeded`.
Versions read with `python_embeded\python.exe -m pip list` (read only, nothing installed).

| Package | Model page (tested) | ComfyUI has | Clash? |
|---|---|---|---|
| python | 3.12 | 3.13.14 | small |
| torch | 2.10.0 | 2.14.0+cu130 | different version |
| torchvision | 0.25.0 | 0.29.0+cu130 | different version |
| **transformers** | **4.57.1** | **5.17.0** | **yes, blocking (see below)** |
| tokenizers | 0.22.x (with transformers 4.57.1) | 0.23.2 | different version |
| huggingface_hub | 0.36.x (with transformers 4.57.1) | 1.33.0 | different major version |
| Pillow | 12.1.1 | 12.3.0 | small |
| einops | 0.8.2 | 0.8.2 | no |
| psutil | 7.2.2 | 7.2.2 | no |
| addict | 2.4.0 | not installed | missing |
| easydict | 1.13 | not installed | missing |
| matplotlib | 3.10.8 | not installed | missing |
| pymupdf | 1.27.2.2 | not installed | missing |

Test in a second throwaway venv with ComfyUI's versions
(`OCR\ocr-test-comfyver`: torch 2.14.0+cu130, torchvision 0.29.0, transformers 5.17.0, tokenizers 0.23.2,
huggingface_hub 1.33.0, plus the missing packages, Python 3.12 because 3.13 is not installed):

1. First try: transformers stopped with `This modeling file requires ... requests`.
   (transformers 5 no longer installs `requests`. ComfyUI does have requests 2.34.2, so it was added to match.)
2. Second try: `ImportError: cannot import name 'is_torch_fx_available' from 'transformers.utils.import_utils'`
   in the model's `modeling_deepseekv2.py`. transformers 5 removed that function.

Stopped there (2 tries). **The model's own code does not load with ComfyUI's transformers.**
Making it work would mean either downgrading transformers inside ComfyUI (would likely break other nodes),
or editing the model's code.

Good to know for later: transformers **5.20.0** (released 2026-10-15) has Unlimited-OCR built in
(`UnlimitedOcrForConditionalGeneration`, no `trust_remote_code`, no `eval()`). The model folder already has
the matching `processor_config.json` and `preprocessor_config.json`. ComfyUI's 5.17 does not have it.
This was not tested.

## PDF upload check (ComfyUI `POST /upload/image`)

Not tested live: ComfyUI was not running, and the ticket says not to start it.

From reading `ComfyUI\server.py` (`image_upload`, lines 400-465): the handler writes the uploaded bytes
straight to the input folder (`f.write(image.file.read())`). It does not check the file type and does not
convert anything. So a `.pdf` should be kept unchanged. If a file with the same name exists and the bytes
differ, it is saved as `name (1).pdf`; if the bytes are the same, the old file is reused.
This needs one live check before FRG-60 depends on it.

## Existing ComfyUI custom nodes (GitHub search, nothing installed)

| Repo | Licence | Last commit | Notes |
|---|---|---|---|
| [endman100/ComfyUI-UnlimitedOCR](https://github.com/endman100/ComfyUI-UnlimitedOCR) | MIT | 2026-07-31 | Runs in ComfyUI's own Python. `requirements.txt` asks for `transformers>=4.57.1` plus addict, easydict, matplotlib, PyMuPDF. Takes an `IMAGE`, returns `STRING`. 2 stars. |
| [PsychoLogicAu/ComfyUI-Unlimited-OCR](https://github.com/PsychoLogicAu/ComfyUI-Unlimited-OCR) | none | 2026-07-09 | No licence, so we cannot reuse its code. README says it downloads the model from Hugging Face on first use. 0 stars. |

Neither was tested. Both need packages installed into ComfyUI's Python, and both would hit the
transformers 5 problem above unless they change the model code.

## Recommendation: C, do not add it now

- **A (our own ComfyUI node): not possible today.** There is a blocking clash: the model code does not
  load with ComfyUI's transformers 5.17, and four packages are missing.
- **B (separate local Python service): works, but not worth it yet.** The venv from this test is a
  working base. But it needs a new stack decision in CLAUDE.md (a Python service next to Node and ComfyUI),
  and the quality on our main document type, well-log prints, is poor. A rotated log header can also tie
  up the GPU for close to half an hour.
- **C (do not add now): recommended.**
  - Our test PDFs are digital and already carry their text. PyMuPDF can read that text exactly, with no model.
  - Look again when ComfyUI ships transformers 5.20 or newer. Then the built-in Unlimited-OCR class may work
    inside ComfyUI with no remote code and no `eval()`. That would make A possible.
  - Before that, test real scans and phone photos, because that is where OCR is really needed.

FRG-59 to FRG-64 are planned around this model. If Jaya picks C, they should wait.
