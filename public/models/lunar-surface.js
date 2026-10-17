import * as THREE from '../vendor/three/three.module.js';

// Deterministic mathematical terrain, generated once and shared by every lunar
// mesh. There are no photographed pixels or externally loaded image resources.
const TAU = Math.PI * 2;
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;

function randomSource(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t ^= t + Math.imul(t ^ t >>> 7, 61 | t);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function hash(x, y, z) {
  let n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647);
  n = Math.imul(n ^ n >>> 13, 1274126177);
  return ((n ^ n >>> 16) >>> 0) / 4294967295;
}

function noise(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  x -= ix; y -= iy; z -= iz;
  x = x * x * (3 - 2 * x); y = y * y * (3 - 2 * y); z = z * z * (3 - 2 * z);
  return mix(
    mix(mix(hash(ix, iy, iz), hash(ix + 1, iy, iz), x),
        mix(hash(ix, iy + 1, iz), hash(ix + 1, iy + 1, iz), x), y),
    mix(mix(hash(ix, iy, iz + 1), hash(ix + 1, iy, iz + 1), x),
        mix(hash(ix, iy + 1, iz + 1), hash(ix + 1, iy + 1, iz + 1), x), y), z);
}

function fractal(x, y, z, octaves = 4) {
  let value = 0, amplitude = .54;
  for (let i = 0; i < octaves; i++) {
    value += (noise(x, y, z) - .5) * amplitude;
    x = x * 2.031 + 5.1; y = y * 2.021 + 1.7; z = z * 2.041 + 9.2;
    amplitude *= .5;
  }
  return value;
}

function direction(longitude, latitude) {
  const c = Math.cos(latitude);
  return [Math.sin(longitude) * c, Math.sin(latitude), Math.cos(longitude) * c];
}

function basis(longitude, latitude) {
  return {
    center: direction(longitude, latitude),
    east: [Math.cos(longitude), 0, -Math.sin(longitude)],
    north: [-Math.sin(longitude) * Math.sin(latitude), Math.cos(latitude), -Math.cos(longitude) * Math.sin(latitude)],
  };
}

/**
 * Creates code-authored lunar albedo and height DataTextures. width=1024 yields
 * a 1024×512 seamless equirectangular map. phase lighting remains a live shader.
 * The recognisable grouping of dark seas is artist-authored, not a scientific
 * terrain reconstruction; all craters, irregular boundaries and rays are math.
 */
export function createLunarTextures({ width = 1024 } = {}) {
  width = Math.max(256, Math.min(4096, Math.round(width / 2) * 2));
  const height = width / 2, count = width * height;
  const random = randomSource(0x4D4F4F4E);
  const coordinates = new Float32Array(count * 3);
  const elevations = new Float32Array(count);
  const tones = new Float32Array(count);
  const seas = new Float32Array(count);

  // Broad, overlapping basins give a lunar face instead of generic rock noise.
  // Values are art direction in radians, not downloaded cartographic samples.
  const maria = [
    [-.57, .11, .31, .53, .93], // broad western ocean
    [-.23, .47, .31, .29, 1.00],
    [.31, .42, .22, .24, .91],
    [.46, .12, .25, .22, .92],
    [.66, -.14, .21, .24, .76],
    [.93, .40, .15, .17, .99],
    [-.18, -.37, .23, .20, .75],
    [-.54, -.40, .16, .17, .82],
    [2.50, -.33, .25, .32, .42],
  ].map(([lon, lat, rx, ry, strength]) => ({ ...basis(lon, lat), rx, ry, strength }));

  for (let y = 0; y < height; y++) {
    // DataTexture rows start at UV v=0, hence south-to-north row ordering.
    const latitude = ((y + .5) / height - .5) * Math.PI;
    const sinLat = Math.sin(latitude), cosLat = Math.cos(latitude);
    for (let x = 0; x < width; x++) {
      const longitude = ((x + .5) / width - .5) * TAU;
      const px = Math.sin(longitude) * cosLat, py = sinLat, pz = Math.cos(longitude) * cosLat;
      const at = y * width + x, xyz = at * 3;
      coordinates[xyz] = px; coordinates[xyz + 1] = py; coordinates[xyz + 2] = pz;
      const continent = fractal(px * 4.7 + 10, py * 4.7, pz * 4.7, 4);
      const texture = fractal(px * 34 + 8, py * 34, pz * 34, 3);
      const fine = noise(px * 230, py * 230 + 11, pz * 230) - .5;
      let sea = 0;
      for (const m of maria) {
        if (px * m.center[0] + py * m.center[1] + pz * m.center[2] < .65) continue;
        const east = (px * m.east[0] + py * m.east[1] + pz * m.east[2]) / m.rx;
        const north = (px * m.north[0] + py * m.north[1] + pz * m.north[2]) / m.ry;
        const d = Math.sqrt(east * east + north * north) + continent * 1.9 + texture * .32;
        sea = Math.max(sea, (1 - smooth(.68, 1.12, d)) * m.strength);
      }
      seas[at] = sea;
      elevations[at] = .55 + continent * .12 + texture * .035 + fine * .003 - sea * .055;
      tones[at] = 171 + continent * 62 + texture * 29 + fine * 9 - sea * (35 + texture * 9);
    }
  }

  function crater(longitude, latitude, radius, age, rayStrength = 0, tag = 0) {
    const { center, east, north } = basis(longitude, latitude);
    const reach = radius * (rayStrength ? 8.0 : 2.05);
    const centerX = (longitude / TAU + .5) * width;
    const centerY = (latitude / Math.PI + .5) * height;
    const dy = Math.ceil(reach * height / Math.PI) + 2;
    const dx = Math.min(width / 2, Math.ceil(reach * width / TAU / Math.max(.08, Math.cos(latitude))) + 3);
    const lowY = Math.max(0, Math.floor(centerY - dy)), highY = Math.min(height - 1, Math.ceil(centerY + dy));
    const depth = (.065 + Math.sqrt(radius) * .22) * (1 - age * .62);
    const rayOffset = tag * 17.81;
    for (let y = lowY; y <= highY; y++) {
      for (let xx = Math.floor(centerX - dx); xx <= Math.ceil(centerX + dx); xx++) {
        const x = (xx % width + width) % width, at = y * width + x, xyz = at * 3;
        const px = coordinates[xyz], py = coordinates[xyz + 1], pz = coordinates[xyz + 2];
        const chord2 = 2 * (1 - (px * center[0] + py * center[1] + pz * center[2]));
        if (chord2 > reach * reach) continue;
        const distance = Math.sqrt(Math.max(chord2, 0)) / radius;
        const e = px * east[0] + py * east[1] + pz * east[2];
        const n = px * north[0] + py * north[1] + pz * north[2];
        const angle = Math.atan2(n, e);
        const irregularity = noise(e / radius * 3 + tag, n / radius * 3, 2.7);
        const r = distance * (1 + (irregularity - .5) * .075);
        const erosion = 1 - age * .7;
        if (r < 1.95) {
          const bowl = -.73 * (1 - smooth(.54, 1.0, r));
          const rimWidth = .10 + age * .075;
          const rim = Math.exp(-(((r - 1.04) / rimWidth) ** 2)) * .31;
          const peak = radius > .035 ? Math.exp(-((r / .17) ** 2)) * .24 : 0;
          const terrace = radius > .055 ? Math.exp(-(((r - .72) / .055) ** 2)) * .075 : 0;
          const ejecta = Math.exp(-Math.max(r - 1.14, 0) * 4) * smooth(1.04, 1.18, r) * .07;
          elevations[at] += (bowl + rim + peak + terrace + ejecta) * depth;
          // Intrinsic fresh ejecta is brighter; directional crater shadows are
          // deliberately left to the real-time normal and lighting shader.
          const apron = Math.exp(-(((r - 1.15) / .32) ** 2));
          tones[at] += apron * (12 + rayStrength * 9) * erosion - (r < .80 ? 2.5 * erosion : 0);
        }
        if (rayStrength && r > 1.10) {
          const wavering = angle + Math.sin(r * 2.3 + tag) * .013;
          const rayNoise = noise(wavering * 18 + rayOffset, 1.4, 9.1) * .72
            + noise(wavering * 47 + rayOffset, 9.3, 4.2) * .28;
          const streak = smooth(.54, .78, rayNoise);
          const radial = Math.exp(-(r - 1.1) * .38) * (1 - smooth(5.5, 8, r));
          tones[at] += rayStrength * streak * radial * 32;
        }
      }
    }
  }

  // Old craters precede younger impacts. A power-law distribution supplies a
  // few visible basins, many small pits, and avoids a uniformly polka-dot skin.
  for (let i = 0; i < 145; i++) {
    const longitude = (random() - .5) * TAU;
    const latitude = Math.asin(random() * 2 - 1);
    const radius = .027 + random() ** 3 * .085;
    crater(longitude, latitude, radius, .45 + random() * .50, 0, i);
  }
  const smallCount = Math.round(width * 1.85);
  for (let i = 0; i < smallCount; i++) {
    const longitude = (random() - .5) * TAU;
    const latitude = Math.asin(random() * 2 - 1);
    const tx = Math.min(width - 1, Math.floor((longitude / TAU + .5) * width));
    const ty = Math.min(height - 1, Math.floor((latitude / Math.PI + .5) * height));
    // Lava plains are visibly smoother than ancient highlands.
    if (random() < seas[ty * width + tx] * .72) continue;
    const radius = .0038 + random() ** 4 * .028;
    crater(longitude, latitude, radius, .15 + random() * .7, 0, i + 200);
  }
  // A handful of fresh, rayed impacts give the near-side its visual landmarks.
  crater(-.17, -.76, .048, .04, 1, 372);
  crater(-.36, .15, .054, .12, .74, 812);
  crater(-.67, .10, .031, .09, .53, 119);
  crater(-.85, .41, .030, .03, .38, 409);
  crater(.49, -.42, .046, .19, .20, 821);

  const colorBytes = new Uint8Array(count * 4);
  // Half-float height avoids quantised contour bands in close crater lighting.
  const heightValues = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    const k = i * 4, tone = clamp(tones[i], 45, 223);
    colorBytes[k] = Math.round(tone * 1.016);
    colorBytes[k + 1] = Math.round(tone * 1.006);
    colorBytes[k + 2] = Math.round(tone * .978);
    colorBytes[k + 3] = 255;
    heightValues[i] = THREE.DataUtils.toHalfFloat(clamp(elevations[i]));
  }
  const albedo = new THREE.DataTexture(colorBytes, width, height, THREE.RGBAFormat);
  const displacement = new THREE.DataTexture(heightValues, width, height, THREE.RedFormat, THREE.HalfFloatType);
  albedo.name = 'Code-generated lunar maria, craters and ejecta';
  displacement.name = 'Code-generated lunar elevation';
  albedo.colorSpace = THREE.SRGBColorSpace;
  displacement.colorSpace = THREE.NoColorSpace;
  for (const texture of [albedo, displacement]) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
  }
  return {
    albedo, displacement,
    dispose() { albedo.dispose(); displacement.dispose(); },
  };
}
