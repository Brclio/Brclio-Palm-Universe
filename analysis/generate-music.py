"""Create the original, replaceable ambient placeholder track without external services."""
from pathlib import Path
import wave
import numpy as np
import subprocess

RATE = 32000
DURATION = 48
rng = np.random.default_rng(19)
mix = np.zeros((RATE * DURATION, 2), dtype=np.float64)

def note(midi, start, length, amp, pan=0.0, pad=False):
    n = min(int(length * RATE), len(mix) - int(start * RATE))
    if n <= 0:
        return
    t = np.arange(n) / RATE
    freq = 440 * 2 ** ((midi - 69) / 12)
    if pad:
        sound = sum(np.sin(2*np.pi*(freq*(1+d))*t + p) for d,p in [(-.0015,0),(.0017,.4),(0,.8)]) / 3
        env = np.minimum(t / 1.5, 1) * np.minimum((length-t)/2, 1) * .6
    else:
        sound = np.sin(2*np.pi*freq*t + .9*np.sin(2*np.pi*freq*2*t)*np.exp(-t*4))
        sound += .15*np.sin(2*np.pi*freq*3*t)*np.exp(-t*2)
        env = (1 - np.exp(-t*45)) * np.exp(-t/1.8) * np.minimum((length-t)/.4, 1)
    s = sound * env * amp
    offset = int(start * RATE)
    mix[offset:offset+n,0] += s * np.sqrt((1-pan)/2)
    mix[offset:offset+n,1] += s * np.sqrt((1+pan)/2)

chords = [[48,55,60,63,67],[44,51,56,60,63],[51,58,63,67,70],[46,53,58,62,65]]
for bar in range(8):
    chord = chords[bar % 4]
    start = bar * 6
    for i,midi in enumerate(chord):
        note(midi,start,8,.052,pan=(i-2)*.18,pad=True)
    for step in range(8):
        midi = chord[[0,2,3,4,2,3,1,4][step]] + 12
        note(midi,start+step*.75,4,.075,pan=np.sin(step*1.7)*.55)
    for step,midi in enumerate([chord[3]+24,chord[4]+24,chord[2]+24]):
        note(midi,start+1.5+step*1.5,3,.025,pan=.35-step*.35)

dry = mix.copy()
for delay,gain in [(0.27,.16),(.53,.11),(.81,.075),(1.37,.045)]:
    shift = int(delay*RATE)
    mix[shift:] += dry[:-shift,::-1]*gain
envelope = np.minimum(np.arange(len(mix))/RATE/2,1) * np.minimum((DURATION-np.arange(len(mix))/RATE)/3,1)
mix *= envelope[:,None]
mix = np.tanh(mix*1.7)
mix *= .76/max(np.max(np.abs(mix)),.001)
out = Path(__file__).resolve().parents[1] / 'public/audio'
out.mkdir(parents=True,exist_ok=True)
wav = out/'lunar-reverie.wav'
with wave.open(str(wav),'wb') as f:
    f.setnchannels(2); f.setsampwidth(2); f.setframerate(RATE)
    f.writeframes((mix*32767).astype('<i2').tobytes())
subprocess.run(['ffmpeg','-y','-hide_banner','-loglevel','error','-i',str(wav),'-codec:a','libmp3lame','-b:a','160k',str(out/'lunar-reverie.mp3')],check=True)
wav.unlink()
print('Original ambient music: public/audio/lunar-reverie.mp3')
