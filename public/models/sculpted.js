import * as THREE from '../vendor/three/three.module.js';

// These are editable meshes, materials and light ribbons. No frame from the
// reference film is used as an image, texture, silhouette or animation here.
const TAU = Math.PI * 2;

function disposeObject(object) {
  const geometries = new Set();
  const materials = new Set();
  object.traverse((child) => {
    if (child.geometry) geometries.add(child.geometry);
    if (child.material) {
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) materials.add(material);
    }
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
}

function roundedStarOutline(segments = 320) {
  // Hand-measured proportions of the rounded, broad-lobed reference shape.
  // The editable Bezier controls define geometry; no source pixels are loaded.
  const contour = new THREE.Path();
  contour.moveTo(87, 22);
  for (const controls of [
    [90, 16, 96, 30, 107, 65], [119, 69, 149, 70, 161, 76],
    [170, 79, 145, 100, 131, 113], [130, 128, 139, 160, 133, 165],
    [125, 168, 98, 146, 85, 146], [73, 146, 47, 169, 42, 164],
    [38, 158, 45, 131, 48, 113], [37, 102, 15, 84, 16, 77],
    [18, 70, 49, 73, 65, 66], [73, 49, 79, 29, 87, 22],
  ]) contour.bezierCurveTo(...controls);
  const points = contour.getSpacedPoints(segments).slice(0, segments)
    .map((point) => new THREE.Vector2(point.x - 89, 96 - point.y));
  // Match the visible width/height convention used by the gesture scene. A
  // bounding-circle radius would make this broad star noticeably too small.
  const radius = Math.max(
    Math.max(...points.map((point) => point.x)) - Math.min(...points.map((point) => point.x)),
    Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y)),
  ) * 0.5;
  return points.map((point) => point.divideScalar(radius));
}

function inflatedStarGeometry() {
  const outline = roundedStarOutline();
  const circumference = outline.length;
  const latitudes = 60;
  const positions = [];
  const colors = [];
  const uv = [];
  const indices = [];
  const center = new THREE.Color('#877e65');
  const edge = new THREE.Color('#dfd5b9');

  // A closed, smooth solid: the two faces meet around a rounded equator.
  // The broad centre and each lobe are inflated, rather than flat extrusions.
  for (let latitude = 0; latitude <= latitudes; latitude++) {
    const phi = latitude / latitudes * Math.PI;
    const radial = Math.sin(phi);
    const sign = Math.cos(phi);
    for (let longitude = 0; longitude < circumference; longitude++) {
      const point = outline[longitude];
      const outlineRadius2 = point.lengthSq();
      const radial2 = radial * radial;
      // A locally spherical crown avoids five sharp creases converging at the
      // centre. The correction gradually gives way to the five-lobed rim.
      const inflation = 1 + 0.5 * radial2 * (1 - outlineRadius2)
        + radial2 * radial2 * (0.375 - 0.25 * outlineRadius2 - 0.125 * outlineRadius2 * outlineRadius2);
      const theta = Math.atan2(point.y, point.x);
      const organicFold = 0.045 * Math.sin(Math.PI * radial) * radial2
        * Math.cos((theta - Math.PI / 2) * 5 + 0.13 * Math.sin(theta * 2));
      const crownDimple = 0.016 * Math.exp(-radial2 / 0.23);
      const depth = (sign >= 0 ? 0.32 : 0.24) * sign * inflation
        + (sign >= 0 ? 1 : -0.45) * (organicFold - crownDimple);
      positions.push(point.x * radial, point.y * radial, depth);
      const tone = center.clone().lerp(edge, radial ** 3 * 0.74);
      colors.push(tone.r, tone.g, tone.b);
      uv.push(point.x * radial * 0.5 + 0.5, point.y * radial * 0.5 + 0.5);
    }
  }
  for (let latitude = 0; latitude < latitudes; latitude++) {
    for (let longitude = 0; longitude < circumference; longitude++) {
      const next = (longitude + 1) % circumference;
      const a = latitude * circumference + longitude;
      const b = latitude * circumference + next;
      const c = (latitude + 1) * circumference + longitude;
      const d = (latitude + 1) * circumference + next;
      indices.push(a, b, c, b, d, c);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  // Longitude copies at the poles otherwise have undefined seam normals.
  const normal = geometry.getAttribute('normal');
  for (let index = 0; index < circumference; index++) {
    normal.setXYZ(index, 0, 0, 1);
    normal.setXYZ(latitudes * circumference + index, 0, 0, -1);
  }
  normal.needsUpdate = true;
  geometry.computeBoundingSphere();
  return geometry;
}

export function createStar() {
  const object = new THREE.Group();
  object.name = 'Sculpted champagne star';
  object.userData.procedural = true;
  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    vertexColors: true,
    metalness: 0.56,
    roughness: 0.40,
    clearcoat: 0.26,
    clearcoatRoughness: 0.38,
    emissive: new THREE.Color('#b4ae96'),
    emissiveIntensity: 0.015,
  });
  const body = new THREE.Mesh(inflatedStarGeometry(), material);
  body.name = 'Closed rounded five-lobed solid';
  object.add(body);
  return {
    object,
    update(time = 0) {
      // The silhouette and its lit surfaces change as a real solid turns.
      body.rotation.set(Math.sin(time * 0.44) * 0.105, Math.sin(time * 0.57 + 0.4) * 0.29, Math.sin(time * 0.35) * 0.055);
    },
    dispose() { disposeObject(object); },
  };
}

function discGeometry() {
  // One lathed solid, including a bevelled outer edge and 118 actual grooves.
  const profile = [
    new THREE.Vector2(0.018, -0.023),
    new THREE.Vector2(0.975, -0.023),
    new THREE.Vector2(0.991, -0.018),
    new THREE.Vector2(1, -0.005),
    new THREE.Vector2(1, 0.012),
    new THREE.Vector2(0.993, 0.026),
  ];
  for (let index = 0; index <= 472; index++) {
    const fraction = index / 472;
    const radius = THREE.MathUtils.lerp(0.99, 0.608, fraction);
    profile.push(new THREE.Vector2(radius, 0.027 + Math.cos(fraction * TAU * 118) * 0.00027));
  }
  profile.push(new THREE.Vector2(0.6, 0.03), new THREE.Vector2(0.018, 0.03), new THREE.Vector2(0.018, -0.023));
  const geometry = new THREE.LatheGeometry(profile, 192);
  geometry.rotateX(Math.PI / 2);
  geometry.computeVertexNormals();
  return geometry;
}

function vinylMaterial() {
  const material = new THREE.MeshPhysicalMaterial({
    color: '#303033',
    metalness: 0.58,
    roughness: 0.4,
    clearcoat: 0.24,
    clearcoatRoughness: 0.3,
  });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vVinylPosition;\nvarying vec3 vVinylFaceNormal;');
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvVinylPosition = position;\nvVinylFaceNormal = normalize(normalMatrix * vec3(0.0, 0.0, 1.0));');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vVinylPosition;\nvarying vec3 vVinylFaceNormal;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
      #include <color_fragment>
      float vinylAngle = atan(vVinylPosition.y, vVinylPosition.x);
      float vinylRadius = length(vVinylPosition.xy);
      float vinylGrain = fract(sin(dot(floor(vVinylPosition.xy * 260.0), vec2(12.9898, 78.233))) * 43758.5453);
      float vinylSector = pow(0.5 + 0.5 * sin(vinylAngle * 2.0 + 0.55), 10.0);
      diffuseColor.rgb *= 0.9 + vinylGrain * 0.035 + vinylSector * 0.42;
    `);
    shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', `
      #include <roughnessmap_fragment>
      roughnessFactor *= 0.95 + 0.025 * sin(vinylAngle * 2.0);
    `);
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', `
      #include <normal_fragment_begin>
      if (vVinylPosition.z > 0.025 && vinylRadius > 0.608) {
        // A groove narrower than a pixel has an averaged flat normal. This
        // filters the actual mesh relief before it can produce moire bands.
        float groovesPerPixel = fwidth(vinylRadius) * 309.0;
        float resolvedGroove = 1.0 - smoothstep(0.3, 0.9, groovesPerPixel);
        normal = normalize(mix(normalize(vVinylFaceNormal), normal, resolvedGroove));
      }
    `);
  };
  material.customProgramCacheKey = () => 'procedural-vinyl-grooves-v2';
  return material;
}

function createLightRibbon(radius, width, phase, colorA, colorB) {
  const segments = 288;
  const position = [];
  const uv = [];
  const indices = [];
  for (let index = 0; index <= segments; index++) {
    for (let side = 0; side < 2; side++) {
      position.push(0, 0, 0);
      uv.push(index / segments, side);
    }
    if (index < segments) {
      const a = index * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices);
  // Vertices are expanded into this annulus in the shader.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.1);
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: 1 },
      uRadius: { value: radius },
      uWidth: { value: width },
      uPhase: { value: phase },
      uColorA: { value: new THREE.Color(colorA) },
      uColorB: { value: new THREE.Color(colorB) },
    },
    vertexShader: `
      uniform float uTime, uRadius, uWidth, uPhase;
      varying vec2 vUv;
      varying float vTwist;
      void main() {
        vUv = uv;
        float theta = uv.x * 6.28318530718;
        float drift = uTime * 0.27 + uPhase;
        float wave = sin(theta * 3.0 + drift) * 0.040
                   + sin(theta * 7.0 - drift * 1.7) * 0.020
                   + sin(theta * 13.0 + drift * 0.7) * 0.006;
        vTwist = sin(theta * 4.0 - drift);
        float ribbonWidth = uWidth * (0.55 + 0.45 * sin(theta * 3.0 + drift));
        float r = uRadius + wave + (uv.y - 0.5) * ribbonWidth;
        vec3 p = vec3(cos(theta) * r, sin(theta) * r, 0.045 + 0.007 * vTwist);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime, uOpacity, uPhase;
      uniform vec3 uColorA, uColorB;
      varying vec2 vUv;
      varying float vTwist;
      void main() {
        float theta = vUv.x * 6.28318530718;
        float drift = uTime * 0.27 + uPhase;
        float crossSection = max(0.0, 1.0 - abs(vUv.y * 2.0 - 1.0));
        float core = pow(crossSection, 4.0);
        float halo = pow(crossSection, 1.25);
        float arc = pow(0.5 + 0.5 * sin(theta * 2.0 - drift), 6.0);
        float secondArc = pow(0.5 + 0.5 * sin(theta * 3.0 + drift * 0.7), 14.0);
        float thread = 0.035 + 1.05 * arc + 0.38 * secondArc;
        float shimmer = 0.82 + 0.18 * sin(theta * 21.0 + drift * 3.0);
        vec3 color = mix(uColorA, uColorB, 0.5 + vTwist * 0.5);
        color = mix(color, vec3(0.67, 1.0, 0.85), core * arc * 0.08);
        gl_FragColor = vec4(color * (1.2 + core * 0.9), (halo * 0.58 + core * 0.32) * thread * shimmer * uOpacity);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Flowing spectral ribbon';
  mesh.renderOrder = 3;
  return mesh;
}

function metalCylinder(radius, depth, material) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, depth, 40), material);
  mesh.rotation.x = Math.PI / 2;
  return mesh;
}

function createTonearm() {
  const arm = new THREE.Group();
  arm.name = 'Fixed curved pickup arm';
  const blackMetal = new THREE.MeshPhysicalMaterial({ color: '#343d3c', metalness: 0.65, roughness: 0.24, clearcoat: 0.35 });
  const polishedRim = new THREE.MeshStandardMaterial({ color: '#889997', metalness: 0.72, roughness: 0.23 });
  const rubber = new THREE.MeshStandardMaterial({ color: '#080b0c', roughness: 0.62, metalness: 0.12 });

  const bearing = metalCylinder(0.052, 0.031, rubber);
  bearing.position.set(0.035, 1.58, 0.08);
  arm.add(bearing);
  const pivot = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.009, 10, 48), blackMetal);
  pivot.position.set(0.035, 1.58, 0.1);
  arm.add(pivot);
  const innerPivot = new THREE.Mesh(new THREE.TorusGeometry(0.025, 0.004, 8, 40), polishedRim);
  innerPivot.position.set(0.035, 1.58, 0.11);
  arm.add(innerPivot);
  const pivotWell = metalCylinder(0.02, 0.005, rubber);
  pivotWell.position.set(0.035, 1.58, 0.104);
  arm.add(pivotWell);

  const points = [
    [0.022, 1.54, 0.09], [0.055, 1.34, 0.095], [0.09, 1.13, 0.10],
    [0.14, 0.94, 0.11], [0.23, 0.78, 0.12], [0.40, 0.63, 0.145], [0.57, 0.49, 0.16],
  ].map((point) => new THREE.Vector3(...point));
  const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 92, 0.015, 12, false), blackMetal);
  tube.name = 'Single continuous metal arm tube';
  arm.add(tube);

  const sleeveStart = points.at(-1);
  const sleeveEnd = new THREE.Vector3(0.637, 0.435, 0.16);
  const direction = sleeveEnd.clone().sub(sleeveStart);
  const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.023, 0.023, direction.length(), 24), blackMetal);
  sleeve.position.copy(sleeveStart).add(sleeveEnd).multiplyScalar(0.5);
  sleeve.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  arm.add(sleeve);

  const head = new THREE.Group();
  head.position.set(0.65, 0.415, 0.165);
  head.rotation.z = Math.PI / 4;
  const casingShape = new THREE.Shape();
  const halfX = 0.041, halfY = 0.056, corner = 0.008;
  casingShape.moveTo(-halfX + corner, -halfY);
  casingShape.lineTo(halfX - corner, -halfY);
  casingShape.quadraticCurveTo(halfX, -halfY, halfX, -halfY + corner);
  casingShape.lineTo(halfX, halfY - corner);
  casingShape.quadraticCurveTo(halfX, halfY, halfX - corner, halfY);
  casingShape.lineTo(-halfX + corner, halfY);
  casingShape.quadraticCurveTo(-halfX, halfY, -halfX, halfY - corner);
  casingShape.lineTo(-halfX, -halfY + corner);
  casingShape.quadraticCurveTo(-halfX, -halfY, -halfX + corner, -halfY);
  const casing = new THREE.Mesh(new THREE.ExtrudeGeometry(casingShape, { depth: 0.027, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 2, steps: 1, curveSegments: 4 }), blackMetal);
  head.add(casing);
  for (const x of [-0.029, 0.029]) {
    const edge = new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.083, 0.003), polishedRim);
    edge.position.set(x, 0, 0.032);
    head.add(edge);
  }
  for (const y of [-0.021, 0.021]) {
    const slot = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.006, 0.002), rubber);
    slot.position.set(0, y, 0.032);
    head.add(slot);
  }
  const stylus = new THREE.Mesh(new THREE.ConeGeometry(0.007, 0.025, 8), polishedRim);
  stylus.rotation.x = Math.PI / 2;
  stylus.position.set(0, -0.04, -0.012);
  head.add(stylus);
  arm.add(head);
  return arm;
}

export function createRecord({ createMoon } = {}) {
  if (typeof createMoon !== 'function') throw new TypeError('createRecord needs a procedural createMoon factory.');
  const object = new THREE.Group();
  object.name = 'Moon vinyl player';
  object.userData.procedural = true;
  const platter = new THREE.Group();
  platter.name = 'Grooved solid vinyl platter';
  const disc = new THREE.Mesh(discGeometry(), vinylMaterial());
  platter.add(disc);
  object.add(platter);

  const edge = new THREE.Mesh(new THREE.TorusGeometry(0.993, 0.0035, 8, 192), new THREE.MeshStandardMaterial({ color: '#393c3e', roughness: 0.46, metalness: 0.72 }));
  edge.position.z = 0.021;
  object.add(edge);
  const innerRim = new THREE.Mesh(new THREE.TorusGeometry(0.607, 0.006, 10, 160), new THREE.MeshPhysicalMaterial({ color: '#585a59', roughness: 0.36, metalness: 0.75 }));
  innerRim.position.z = 0.039;
  object.add(innerRim);

  const moon = createMoon({ phase: 0.14 });
  moon.object.scale.setScalar(0.58);
  moon.object.position.z = 0.032;
  moon.object.name = 'Moon sphere embedded in record';
  object.add(moon.object);

  const ribbons = [
    createLightRibbon(0.657, 0.080, 0.2, '#43b68d', '#79c8ae'),
    createLightRibbon(0.714, 0.065, 2.1, '#3ba79d', '#69b4d1'),
    createLightRibbon(0.790, 0.040, 4.6, '#6dbf9f', '#388cae'),
    createLightRibbon(0.856, 0.026, 1.1, '#4b92ab', '#82baa0'),
    createLightRibbon(0.728, 0.11, 5.1, '#378f73', '#3a79ac'),
  ];
  ribbons.at(-1).material.uniforms.uOpacity.value = 0.35;
  ribbons.at(-1).userData.baseOpacity = 0.35;
  ribbons.forEach((ribbon) => object.add(ribbon));
  object.add(createTonearm());

  let animationTime = 0;
  let previousInputTime = null;
  return {
    object,
    update(time = 0, { playing = true } = {}) {
      // Accepts a playback clock; also guards against callers passing wall time
      // while paused. Resuming never advances by the time spent paused.
      if (previousInputTime === null) previousInputTime = time;
      if (playing) animationTime += Math.max(0, time - previousInputTime);
      previousInputTime = time;
      platter.rotation.z = -animationTime * 0.11;
      moon.update?.(animationTime * 0.42, { phase: 0.14 + 0.10 * Math.sin(animationTime * 0.38) });
      for (const ribbon of ribbons) ribbon.material.uniforms.uTime.value = animationTime;
    },
    reset() {
      animationTime = 0;
      previousInputTime = null;
      platter.rotation.z = 0;
      moon.update?.(0, { phase: 0.14 });
      for (const ribbon of ribbons) ribbon.material.uniforms.uTime.value = 0;
    },
    dispose() {
      moon.dispose?.();
      disposeObject(object);
    },
  };
}
