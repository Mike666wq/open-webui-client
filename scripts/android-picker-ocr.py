#!/usr/bin/env python3
"""Locate the rendered DocumentsUI SAVE button; runner-only screenshot fallback."""
import argparse
import csv
import io
import json
from pathlib import Path
import subprocess
import sys


def locate_save(source, evidence):
    evidence.mkdir(parents=True, exist_ok=True)
    width, height = map(int, subprocess.check_output(['identify', '-format', '%w %h', str(source)], text=True).split())
    rgb = subprocess.check_output(['convert', str(source), '-depth', '8', 'rgb:-'])
    assert len(rgb) == width * height * 3, 'UNVERIFIED: screenshot decode failed'
    # Find connected blue Material surfaces in the actual screenshot. No fixed
    # screen position or density is assumed. Text recognition must independently
    # identify SAVE inside the candidate before any coordinate is returned.
    pixels = {i for i in range(width * height)
              if rgb[i*3+2] > 150 and rgb[i*3+2] > rgb[i*3] * 1.5
              and 60 < rgb[i*3+1] < 200 and rgb[i*3+2] > rgb[i*3+1] * 1.1}
    regions = []
    while pixels:
        seed = pixels.pop()
        pending = [seed]
        left = right = seed % width
        top = bottom = seed // width
        count = 0
        while pending:
            item = pending.pop()
            x, y = item % width, item // width
            left, right = min(left, x), max(right, x)
            top, bottom = min(top, y), max(bottom, y)
            count += 1
            for neighbor in (item-width, item+width, item-1 if x else -1,
                             item+1 if x+1 < width else -1):
                if neighbor in pixels:
                    pixels.remove(neighbor)
                    pending.append(neighbor)
        if count >= 500 and right-left > bottom-top:
            regions.append((left, top, right-left+1, bottom-top+1))
    matches = []
    for index, (left, top, w, h) in enumerate(regions):
        crop = evidence / f'save-candidate-{index}.png'
        subprocess.run(['convert', str(source), '-crop', f'{w}x{h}+{left}+{top}', '+repage',
                        '-colorspace', 'Gray', '-negate', '-resize', '300%', '-bordercolor', 'white',
                        '-border', '20', str(crop)], check=True, timeout=30)
        tsv = subprocess.check_output(['tesseract', str(crop), 'stdout', '--psm', '7', 'tsv'], text=True, timeout=30)
        (evidence / f'save-candidate-{index}.tsv').write_text(tsv, encoding='utf-8')
        words = [row for row in csv.DictReader(io.StringIO(tsv), delimiter='\t') if row['text'].strip()]
        print(json.dumps({'bounds': [left, top, w, h], 'words': [{'text': row['text'], 'confidence': row['conf']} for row in words]}), file=sys.stderr)
        if len(words) == 1 and words[0]['text'].strip().upper() == 'SAVE' and float(words[0]['conf']) >= 80:
            matches.append({'x': left+w//2, 'y': top+h//2, 'bounds': [left, top, left+w, top+h]})
    assert len(matches) == 1, 'UNVERIFIED: visible SAVE button is not unique/confident'
    return matches[0]


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', required=True, type=Path)
    parser.add_argument('--evidence', required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(locate_save(args.image, args.evidence)))
