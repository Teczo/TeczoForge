# Unlimited-OCR: one raw output (FRG-58)

This is the raw model output, exactly as the model returned it, with the layout tags kept.
It is here so later tickets (FRG-59 to FRG-62) can see the real format.

- Document: `teczo-ocr-public-sample.pdf`, a made-up 3-page public sample (no client data).
- Run: `run_test.py --mode multi` (one `infer_multi` call, 3 pages at 300 dpi, `image_size=1024`).
- Model revision: `8249d20b2822a7d8a4c22c8d8c9069b5ac36bda3`.

How to read it:
- `<PAGE>` starts each page (multi-page mode only).
- `<|det|>type [x1, y1, x2, y2]<|/det|>` starts each block. The box is on a 0-999 scale for the page width and height.
- Block types seen: `title`, `text`, `list`, `table`, `image`, `image_caption`. Tables come as HTML `<table>`.
- An `image` block has no text. Labels inside drawings are not read.

## Raw output

````text
<PAGE><|det|>title [257, 95, 743, 119]<|/det|>Pump Station Maintenance Guide
<|det|>text [126, 126, 846, 155]<|/det|>Public sample document for OCR testing. Version 1.2, October 2026. All names and numbers in this file are invented.
<|det|>title [128, 190, 254, 210]<|/det|>1. Purpose
<|det|>text [126, 217, 869, 262]<|/det|>This guide explains the weekly and monthly checks for a small water pump station. It covers safety, inspection steps, and how to record results. Follow the steps in order. Stop work and report to the supervisor if any reading is outside the normal range.
<|det|>title [127, 276, 414, 295]<|/det|>2. Safety before you start
<|det|>list [128, 303, 667, 342]<|/det|>
<|det|>text [128, 303, 512, 318]<|/det|>1. Wear gloves, safety glasses and steel-toe boots.
<|det|>text [127, 324, 527, 339]<|/det|>2. Isolate the pump at the main switch and lock it out.
<|det|>text [127, 345, 666, 362]<|/det|>3. Check that the pressure gauge reads 0 bar before opening any valve.
<|det|>text [127, 367, 401, 383]<|/det|>4. Never work alone in the pump pit.
<|det|>title [127, 397, 327, 416]<|/det|>3. Weekly checks
<|det|>text [126, 424, 830, 468]<|/det|>Listen for unusual noise from the motor bearings. Check the seal area for drips. Read the flow meter and the discharge pressure, and write both values in the log sheet on page 2. A normal discharge pressure is between 3.5 and 4.2 bar.
<PAGE><|det|>title [127, 94, 431, 114]<|/det|>4. Inspection log (week 41)
<|det|>text [127, 121, 457, 137]<|/det|>Table 1. Readings taken at 08:00 each day.
<|det|>table [136, 144, 865, 297]<|/det|><table><tr><td>Day</td><td>Flow (m3/h)</td><td>Pressure (bar)</td><td>Motor temp (°C)</td><td>Status</td><td>Initials</td></tr><tr><td>Mon</td><td>42.5</td><td>3.8</td><td>61</td><td>OK</td><td>AR</td></tr><tr><td>Tue</td><td>41.9</td><td>3.9</td><td>62</td><td>OK</td><td>AR</td></tr><tr><td>Wed</td><td>38.2</td><td>3.4</td><td>67</td><td>Check</td><td>MK</td></tr><tr><td>Thu</td><td>43.1</td><td>3.8</td><td>60</td><td>OK</td><td>MK</td></tr><tr><td>Fri</td><td>42.7</td><td>4.0</td><td>61</td><td>OK</td><td>SL</td></tr><tr><td>Total/ Avg</td><td>41.7</td><td>3.78</td><td>62.2</td><td>-</td><td>-</td></tr></table>
<|det|>text [125, 319, 851, 349]<|/det|>Note: on Wednesday the pressure was below 3.5 bar and the motor was warm. The strainer was cleaned at 10:30 and readings were normal again by 11:00.
<|det|>title [127, 364, 289, 384]<|/det|>5. Spare parts
<|det|>table [136, 390, 865, 476]<|/det|><table><tr><td>Part no.</td><td>Description</td><td>Qty</td><td>Unit price (RM)</td></tr><tr><td>PS-1001</td><td>Mechanical seal, 35 mm</td><td>2</td><td>185.00</td></tr><tr><td>PS-1002</td><td>Bearing 6205-2RS</td><td>4</td><td>32.50</td></tr><tr><td>PS-1003</td><td>Strainer basket, stainless</td><td>1</td><td>240.00</td></tr></table>
<PAGE><|det|>title [126, 94, 333, 114]<|/det|>6. Layout drawing
<|det|>image_caption [126, 121, 559, 138]<|/det|>Figure 1. Simple layout of the pump station (not to scale).
<|det|>image [129, 156, 933, 468]<|/det|>
<|det|>text [126, 493, 811, 510]<|/det|>Legend: T = tank, P = pump, PG = pressure gauge, V = valve, MCC = motor control centre.
<|det|>title [127, 523, 250, 544]<|/det|>7. Sign-off
<|det|>text [127, 550, 624, 567]<|/det|>Checked by: ____ Date: ____ / ____ / 2026
````
