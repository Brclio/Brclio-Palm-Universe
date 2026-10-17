"""Project NASA SVS / LRO lunar albedo onto a sphere and light nine phases."""
from pathlib import Path
from PIL import Image
import numpy as np

out = Path(__file__).resolve().parents[1] / 'public/textures'
tex = np.asarray(Image.open(out/'lroc-color-2k.jpg').convert('RGB'), dtype=float)
size = 384
y,x = np.mgrid[:size,:size]
nx = (x+.5-size/2)/(size/2-2)
ny = (y+.5-size/2)/(size/2-2)
rr=nx*nx+ny*ny
z=np.sqrt(np.maximum(0,1-rr))
u=.5+np.arctan2(nx,z)/(2*np.pi)
v=.5+np.arcsin(np.clip(ny,-1,1))/np.pi
ix=np.clip((u*(tex.shape[1]-1)).astype(int),0,tex.shape[1]-1)
iy=np.clip((v*(tex.shape[0]-1)).astype(int),0,tex.shape[0]-1)
base=tex[iy,ix]*1.4
for i,phase in enumerate(np.linspace(-np.pi,np.pi,9)):
    light=np.maximum(0,nx*np.sin(phase)+z*np.cos(phase))
    brightness=(.018+.982*np.power(light,.38))*(.76+.24*z)
    rgba=np.zeros((size,size,4),dtype=np.uint8)
    rgba[:,:,:3]=np.clip(base*brightness[:,:,None]*np.array([1.04,1.025,.94]),0,255).astype(np.uint8)
    rgba[:,:,3]=(np.clip((1-rr)*size/2,0,1)*255).astype(np.uint8)
    Image.fromarray(rgba).save(out/f'moon-phase-{i}.png',optimize=True)
print('Nine NASA-textured lunar phase sprites generated.')
