"""Build short, event-triggered SFX from the supplied mixed soundtrack.

Requires Python + numpy and ffmpeg. No speech stem or isolated original SFX
exists: the first seven cues are spectrally attenuated excerpts. Record and
burst are noise reconstructions guided by the source envelope/spectral shape,
so they cannot bring the original song or its vocal into the webpage.
"""
from pathlib import Path
import hashlib
import json
import subprocess
import wave
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / '明晚胡彦斌将携TRA_20261017122234.mp4'
OUT = ROOT / 'public/audio/sfx'
RATE, N, HOP = 24000, 1024, 256
CUES = [
    ('summon', 'star', 15.76, 16.42, 'source-excerpt'),
    ('sweepSun', 'sun', 16.98, 17.40, 'source-excerpt'),
    ('sweepMoon', 'moon', 18.20, 18.64, 'source-excerpt'),
    ('grab', 'moonHeld', 19.62, 19.98, 'source-excerpt'),
    ('release', 'moonReleased', 21.44, 22.06, 'source-excerpt'),
    ('phases', 'phases', 22.98, 24.10, 'source-excerpt'),
    ('collect', 'phaseHeld', 24.92, 25.28, 'source-excerpt'),
    ('record', 'pan', 26.66, 27.28, 'envelope-reconstruction'),
    ('burst', 'burst', 32.67, 33.65, 'envelope-reconstruction'),
]


def frames(samples):
    padded = np.pad(samples, ((N // 2, N), (0, 0)))
    count = (len(padded) - N) // HOP + 1
    return np.stack([padded[i * HOP:i * HOP + N] for i in range(count)])


def smooth(values, width, axis):
    kernel = np.ones(width) / width
    return np.apply_along_axis(lambda a: np.convolve(a, kernel, 'same'), axis, values)


def stft(samples):
    return np.fft.rfft(frames(samples) * np.hanning(N)[None, :, None], axis=1)


def restore(spectrum, length):
    window = np.hanning(N)
    blocks = np.fft.irfft(spectrum, n=N, axis=1) * window[None, :, None]
    result = np.zeros(((len(blocks) - 1) * HOP + N, 2))
    weights = np.zeros(len(result))
    for i, block in enumerate(blocks):
        offset = i * HOP
        result[offset:offset + N] += block
        weights[offset:offset + N] += window ** 2
    result /= np.maximum(weights[:, None], 1e-8)
    return result[N // 2:N // 2 + length]


def cleaned_excerpt(samples, baseline):
    spectrum = stft(samples)
    magnitude = np.abs(spectrum)
    # The continuous bed is estimated outside the selected action. Attenuation
    # retains a small floor and is smoothed to avoid hard spectral holes.
    floor = np.quantile(np.abs(stft(baseline)), .55, axis=0)
    mask = np.clip(1 - 1.35 * (floor / np.maximum(magnitude, 1e-7)) ** 1.45, .035, 1)
    mask = smooth(smooth(mask, 3, 0), 3, 1)
    hz = np.fft.rfftfreq(N, 1 / RATE)
    band = (1 / np.sqrt(1 + (110 / np.maximum(hz, 1)) ** 8))
    band *= 1 / np.sqrt(1 + (hz / 10500) ** 12)
    return restore(spectrum * mask * band[None, :, None], len(samples))


def reconstructed_noise(samples, seed):
    # Reuse only a smooth energy contour and broad spectral colour. Random
    # phase/noise replaces fine harmonic structure, not a vocal remover.
    rng = np.random.default_rng(seed)
    source = stft(samples)
    shape = np.mean(np.abs(source), axis=(0, 2))
    shape = smooth(shape, 35, 0)
    hz = np.fft.rfftfreq(N, 1 / RATE)
    shape *= 1 / np.sqrt(1 + (750 / np.maximum(hz, 1)) ** 6)
    shape *= 1 / np.sqrt(1 + (hz / 9000) ** 10)
    shape /= max(np.max(shape), 1e-8)
    noise = rng.normal(0, 1, (len(samples), 2))
    shaped = restore(stft(noise) * shape[None, :, None], len(samples))
    energy = np.sqrt(np.mean(np.abs(source[:, hz > 1500, :]) ** 2, axis=(1, 2)))
    energy = smooth(energy, 5, 0)
    energy /= max(np.max(energy), 1e-8)
    envelope = np.interp(np.arange(len(samples)) / RATE, np.arange(len(energy)) * HOP / RATE, energy)
    # Keep the short decay audible without a sustained background bed.
    envelope *= np.linspace(1, 0, len(samples)) ** .4
    return shaped * envelope[:, None]


def finish(samples):
    samples = samples - samples.mean(axis=0)
    rms = np.sqrt(np.mean(samples ** 2))
    peak = np.max(np.abs(samples))
    samples *= min(.085 / max(rms, 1e-8), .56 / max(peak, 1e-8), 6)
    fade_in, fade_out = min(240, len(samples) // 3), min(1800, len(samples) // 3)
    samples[:fade_in] *= np.sin(np.linspace(0, np.pi / 2, fade_in))[:, None] ** 2
    samples[-fade_out:] *= np.sin(np.linspace(np.pi / 2, 0, fade_out))[:, None] ** 2
    return samples


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(SOURCE), '-vn', '-ac', '2', '-ar', str(RATE), '-f', 'f32le', '-'])
    signal = np.frombuffer(raw, dtype='<f4').reshape(-1, 2).astype(float)
    baseline = signal[int(14.35 * RATE):int(15.4 * RATE)]
    manifest, measurements = [], []
    for i, (cue, stage, start, end, method) in enumerate(CUES):
        samples = signal[round(start * RATE):round(end * RATE)]
        processed = cleaned_excerpt(samples, baseline) if method == 'source-excerpt' else reconstructed_noise(samples, 601 + i)
        output = finish(processed)
        name = cue + '.wav'
        with wave.open(str(OUT / name), 'wb') as wav:
            wav.setnchannels(2)
            wav.setsampwidth(2)
            wav.setframerate(RATE)
            wav.writeframes(np.round(output * 32767).astype('<i2').tobytes())
        manifest.append({'id': cue, 'file': name, 'stage': stage, 'duration': len(output) / RATE, 'gain': .8,
                         'sourceRange': [start, end], 'method': method})
        measurements.append({'id': cue, 'peak': float(np.max(np.abs(output))), 'rms': float(np.sqrt(np.mean(output ** 2))),
                             'firstSample': output[0].tolist(), 'lastSample': output[-1].tolist(),
                             'bytes': (OUT / name).stat().st_size, 'sha256': hashlib.sha256((OUT / name).read_bytes()).hexdigest()})
    (OUT / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    report = {'source': SOURCE.name, 'sampleRate': RATE, 'channels': 2, 'cues': measurements,
              'notes': ['Seven short source excerpts with spectral bed attenuation; mixed-source residue may remain.',
                        'Record and burst use only source envelope and broad spectral shape with generated noise.',
                        'No auditory review was possible; signal checks do not prove perceptual identity.']}
    (ROOT / 'analysis/sfx/asset-validation.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(f'Built {len(manifest)} short cues: {sum(m["bytes"] for m in measurements):,} bytes')


if __name__ == '__main__':
    main()
