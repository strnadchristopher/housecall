#!/usr/bin/python3
"""Synthetic desktop only: visible clock/barcode, real guest audio and keyboard receipt."""
import math
from pathlib import Path
import struct
import subprocess
import time
import tkinter as tk
import wave

wave_path = '/tmp/chriscord-fixture-tone.wav'
with wave.open(wave_path, 'wb') as output:
    output.setparams((2, 2, 48000, 0, 'NONE', 'not compressed'))
    output.writeframes(b''.join(struct.pack('<hh', sample, sample) for sample in
        (int(6000 * math.sin(2 * math.pi * 440 * i / 48000)) for i in range(48000))))
audio = subprocess.Popen(['/bin/sh', '-c', 'while true; do aplay -q /tmp/chriscord-fixture-tone.wav || exit; done'])
subprocess.run(['xrandr', '-s', '1280x720'], check=True)
root = tk.Tk()
root.attributes('-fullscreen', True)
canvas = tk.Canvas(root, width=1280, height=720, highlightthickness=0, background='black')
canvas.pack(fill='both', expand=True)
rectangles = [canvas.create_rectangle(i*32, 0, i*32+31, 63, fill='black', outline='') for i in range(32)]
label = canvas.create_text(640, 320, fill='white', font=('DejaVu Sans', 40), text='')
canvas.create_text(640, 440, fill='white', font=('DejaVu Sans', 24), text='Synthetic Debian desktop. Press a to prove input.')
def key(event):
    if event.char == 'a':
        Path('/root/chriscord-input-marker').write_text('guest received a\n')
        canvas.configure(background='#184080')
root.bind('<KeyPress>', key)
root.bind('<Button-1>', lambda _event: Path('/root/chriscord-pointer-marker').write_text('guest received click\n'))
def frame():
    stamp = int(time.time()*1000) & 0xffffffff
    for i, item in enumerate(rectangles):
        canvas.itemconfigure(item, fill='white' if stamp & (1 << i) else 'black')
    canvas.itemconfigure(label, text=f'Debian VM {stamp}')
    root.after(33, frame)
try:
    frame()
    root.mainloop()
finally:
    audio.terminate()
    audio.wait(timeout=3)
