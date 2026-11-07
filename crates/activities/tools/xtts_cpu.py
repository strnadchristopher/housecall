#!/usr/bin/env python3
"""Offline local XTTS-v2 adapter. Caller supplies already-installed model weights."""
import argparse
import os
from pathlib import Path
import wave

os.environ['CUDA_VISIBLE_DEVICES'] = ''
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--reference', type=Path, required=True)
    parser.add_argument('--model-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--text', required=True)
    args = parser.parse_args()
    if not args.text.strip() or len(args.text.encode()) > 4096:
        parser.error('text must contain 1–4096 UTF-8 bytes')
    with wave.open(str(args.reference), 'rb') as reference:
        duration = reference.getnframes() / reference.getframerate()
        if reference.getnchannels() != 1 or reference.getsampwidth() != 2 or reference.getframerate() != 24000 or not 6 <= duration <= 30:
            parser.error('reference must be 6–30 seconds, mono, 24 kHz, PCM 16-bit WAV')
    for name in ['config.json', 'model.pth', 'vocab.json', 'speakers_xtts.pth']:
        if not (args.model_dir / name).is_file():
            parser.error(f'model missing {name}; install model offline first')
    import torch
    import torchaudio
    from TTS.tts.configs.xtts_config import XttsConfig
    from TTS.tts.models.xtts import Xtts
    torch.set_num_threads(2)
    config = XttsConfig()
    config.load_json(str(args.model_dir / 'config.json'))
    model = Xtts.init_from_config(config)
    model.load_checkpoint(config, checkpoint_dir=str(args.model_dir), use_deepspeed=False)
    model.cpu().eval()
    with torch.inference_mode():
        latent, embedding = model.get_conditioning_latents(audio_path=[str(args.reference)])
        result = model.inference(args.text, 'en', latent, embedding, enable_text_splitting=True)
    torchaudio.save(str(args.output), torch.tensor(result['wav']).unsqueeze(0), 24000)


if __name__ == '__main__':
    main()
