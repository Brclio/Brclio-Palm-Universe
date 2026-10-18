import * as THREE from '../vendor/three/three.module.js';
export { createLunarTextures } from './lunar-surface.js';

// These are live, volumetric objects. No frame, mask, sprite, or movie from the
// reference recording is used here. Code-generated albedo may be supplied by
// the caller; models never own (or dispose) those shared procedural textures.

const NOISE = /* glsl */ `
  vec3 hash33(vec3 p) {
    p = fract(p * vec3(.1031, .1030, .0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx);
  }
  float noise3(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    float a = dot(hash33(i) * 2.0 - 1.0, f);
    float b = dot(hash33(i + vec3(1,0,0)) * 2.0 - 1.0, f - vec3(1,0,0));
    float c = dot(hash33(i + vec3(0,1,0)) * 2.0 - 1.0, f - vec3(0,1,0));
    float d = dot(hash33(i + vec3(1,1,0)) * 2.0 - 1.0, f - vec3(1,1,0));
    float e = dot(hash33(i + vec3(0,0,1)) * 2.0 - 1.0, f - vec3(0,0,1));
    float g = dot(hash33(i + vec3(1,0,1)) * 2.0 - 1.0, f - vec3(1,0,1));
    float h = dot(hash33(i + vec3(0,1,1)) * 2.0 - 1.0, f - vec3(0,1,1));
    float j = dot(hash33(i + vec3(1,1,1)) * 2.0 - 1.0, f - vec3(1,1,1));
    return mix(mix(mix(a,b,u.x),mix(c,d,u.x),u.y),
               mix(mix(e,g,u.x),mix(h,j,u.x),u.y),u.z);
  }
  float fbm3(vec3 p) {
    float v = .55 * noise3(p);
    p = p.yzx * 2.03 + vec3(8.2, 1.7, 5.4);
    v += .27 * noise3(p);
    p = p.yzx * 2.01 + vec3(2.5, 6.1, 4.7);
    return v + .13 * noise3(p);
  }
`;

// Optical scatter lives on a larger sphere, independently of the rotating
// terrain. Two decay lengths give a luminous edge and a broad, soft shoulder,
// without a hard ring or a flat sprite. The lunar halo follows the lit limb.
function createOpticalHalo(solar = false) {
  const radius = solar ? 1.95 : 1.62;
  const geometry = new THREE.SphereGeometry(radius, 64, 40);
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: {
      uOpacity: { value: 1 }, uTime: { value: 0 },
      uRadius: { value: radius }, uSolar: { value: solar ? 1 : 0 },
      uLightDirection: { value: new THREE.Vector3(0, .06, 1).normalize() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vViewNormal;
      void main() {
        vViewNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uOpacity, uTime, uRadius, uSolar;
      uniform vec3 uLightDirection;
      varying vec3 vViewNormal;
      ${NOISE}
      void main() {
        vec3 n = normalize(vViewNormal);
        float radius = length(n.xy) * uRadius;
        if (radius < .94) discard;
        float distanceFromLimb = max(radius - 1.0, 0.0);
        vec3 limb = normalize(vec3(n.xy, 0.0));
        float illumination = pow(clamp((1.0 + uLightDirection.z) * .5, 0.0, 1.0), .45);
        float litEdge = smoothstep(-.14, .36, dot(limb, uLightDirection)
          + .48 * max(uLightDirection.z, 0.0));
        float lunar = (.21 * exp(-distanceFromLimb * 24.0)
          + .20 * exp(-distanceFromLimb * 7.0)) * illumination * (.06 + .94 * litEdge);
        float activity = .88 + .25 * noise3(limb * 4.2 + vec3(0, uTime * .09, 2.7));
        float solar = (.48 * exp(-distanceFromLimb * 17.0)
          + .36 * exp(-distanceFromLimb * 5.4)) * activity
          * (.82 + .22 * smoothstep(-.6, .6, limb.y - limb.x));
        float alpha = mix(lunar, solar, uSolar) * smoothstep(.94, 1.015, radius)
          * (1.0 - smoothstep(uRadius - .22, uRadius, radius));
        vec3 lunarColor = vec3(1.28, 1.18, .90);
        vec3 solarColor = mix(vec3(2.0, 1.0, .12), vec3(1.15, .60, .19),
          smoothstep(0.0, .38, distanceFromLimb));
        gl_FragColor = vec4(mix(lunarColor, solarColor, uSolar), alpha * uOpacity);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const object = new THREE.Mesh(geometry, material);
  object.name = solar ? 'Soft solar optical halo' : 'Soft lunar edge glow';
  object.renderOrder = 2;
  return { object, uniforms: material.uniforms, dispose() { geometry.dispose(); material.dispose(); } };
}

const MOON_VERTEX = /* glsl */ `
  uniform sampler2D uDisplacement;
  uniform float uHasDisplacement;
  varying vec2 vUv;
  varying vec3 vLocalPosition;
  varying vec3 vViewPosition;
  varying vec3 vViewNormal;
  varying float vObjectScale;
  varying float vOrthographic;
  void main() {
    vUv = uv;
    float relief = texture2D(uDisplacement, uv).r - .5;
    vec3 p = position + normal * relief * .008 * uHasDisplacement;
    vLocalPosition = position;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vViewPosition = mv.xyz;
    vViewNormal = normalize(normalMatrix * normal);
    vObjectScale = length(modelViewMatrix[0].xyz);
    vOrthographic = step(-.5, projectionMatrix[2][3]);
    gl_Position = projectionMatrix * mv;
  }
`;

const MOON_FRAGMENT = /* glsl */ `
  uniform sampler2D uAlbedo;
  uniform sampler2D uDisplacement;
  uniform float uHasAlbedo;
  uniform float uHasDisplacement;
  uniform float uOpacity;
  uniform vec3 uLightDirection;
  varying vec2 vUv;
  varying vec3 vLocalPosition;
  varying vec3 vViewPosition;
  varying vec3 vViewNormal;
  varying float vObjectScale;
  varying float vOrthographic;
  ${NOISE}
  vec3 surfaceNormal(vec3 position, vec3 normal, float height) {
    vec3 dx = dFdx(position), dy = dFdy(position);
    vec3 rx = cross(dy, normal), ry = cross(normal, dx);
    float determinant = dot(dx, rx);
    vec3 gradient = sign(determinant) * (dFdx(height) * rx + dFdy(height) * ry);
    return normalize(abs(determinant) * normal - gradient);
  }
  void main() {
    vec3 texel = texture2D(uAlbedo, vUv).rgb;
    float terrain = .55 + .24 * fbm3(normalize(vLocalPosition) * 4.0);
    vec3 albedo = mix(vec3(terrain), texel, uHasAlbedo);
    float luminance = dot(albedo, vec3(.2126, .7152, .0722));
    float relief = mix(luminance, texture2D(uDisplacement, vUv).r, uHasDisplacement);
    float micro = noise3(vLocalPosition * 160.0);
    vec3 n = surfaceNormal(vViewPosition, normalize(vViewNormal), (relief * .014 + micro * .00022) * vObjectScale);
    float incidence = dot(n, normalize(uLightDirection));
    // A real light direction moves the terminator across the sphere. The small
    // earthshine term preserves an almost-black silhouette on unlit phases.
    float diffuse = smoothstep(-.035, .045, incidence) * pow(max(incidence, 0.0), .62);
    vec3 eye = normalize(mix(-vViewPosition, vec3(0,0,1), vOrthographic));
    float rim = pow(1.0 - max(dot(n, eye), 0.0), 4.0);
    float earthshine = .025 + .008 * rim;
    // Keep the procedural maria/crater map in the reference's warm grey range.
    albedo = mix(vec3(luminance), albedo, .25) * vec3(1.16, 1.10, .83);
    vec3 color = albedo * (earthshine + 1.25 * diffuse);
    gl_FragColor = vec4(color, uOpacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * A unit-radius moon. phase is light angle / PI:
 *   0 = full, .5 = right-lit half, 1 = dark/new moon.
 * Negative values place the illuminated crescent on the left instead.
 */
export function createMoon({ albedo = null, displacement = null, phase = 0 } = {}) {
  const fallback = new THREE.DataTexture(new Uint8Array([157, 155, 145, 255]), 1, 1);
  fallback.needsUpdate = true;
  const uniforms = {
    uAlbedo: { value: albedo || fallback },
    uDisplacement: { value: displacement || fallback },
    uHasAlbedo: { value: albedo ? 1 : 0 },
    uHasDisplacement: { value: displacement ? 1 : 0 },
    uLightDirection: { value: new THREE.Vector3(0, .04, 1).normalize() },
    uOpacity: { value: 1 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms, vertexShader: MOON_VERTEX, fragmentShader: MOON_FRAGMENT,
    transparent: true, depthWrite: true,
  });
  const geometry = new THREE.SphereGeometry(1, 96, 64);
  const surface = new THREE.Mesh(geometry, material);
  surface.name = 'Lunar surface — sphere with relief and phase lighting';
  // Equirectangular maps have their near-side centre at U=.5.
  surface.rotation.y = -Math.PI / 2;
  const object = new THREE.Group();
  object.name = 'Live 3D moon';
  object.add(surface);
  const halo = createOpticalHalo();
  object.add(halo.object);
  let currentPhase = phase;
  function update(time = 0, options = {}) {
    if (Number.isFinite(options.phase)) currentPhase = options.phase;
    const angle = THREE.MathUtils.clamp(currentPhase, -1, 1) * Math.PI
      + .33 * Math.pow(1 - Math.min(1, Math.abs(currentPhase) / .25), 2);
    uniforms.uLightDirection.value.set(Math.sin(angle), .06, Math.cos(angle)).normalize();
    halo.uniforms.uLightDirection.value.copy(uniforms.uLightDirection.value);
    halo.uniforms.uTime.value = time;
    // Rotate the actual relief-bearing sphere (one turn in ~63 seconds).
    // Lighting stays in view space, so rotation never changes the moon phase.
    surface.rotation.y = -Math.PI / 2 + time * .10;
    surface.rotation.x = Math.sin(time * .023) * .018;
    if (Number.isFinite(options.opacity)) {
      uniforms.uOpacity.value = halo.uniforms.uOpacity.value = options.opacity;
    }
  }
  update(0);
  return {
    object, update,
    dispose() { geometry.dispose(); material.dispose(); halo.dispose(); fallback.dispose(); },
  };
}

const SUN_VERTEX = /* glsl */ `
  varying vec3 vLocalPosition;
  varying vec3 vViewNormal;
  varying vec3 vViewPosition;
  varying float vOrthographic;
  void main() {
    vLocalPosition = position;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewPosition = mv.xyz;
    vViewNormal = normalize(normalMatrix * normal);
    vOrthographic = step(-.5, projectionMatrix[2][3]);
    gl_Position = projectionMatrix * mv;
  }
`;

const SUN_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uOpacity;
  varying vec3 vLocalPosition;
  varying vec3 vViewNormal;
  varying vec3 vViewPosition;
  varying float vOrthographic;
  ${NOISE}
  void main() {
    vec3 p = normalize(vLocalPosition);
    vec3 drift = vec3(0.0, uTime * .085, uTime * .027);
    vec3 warp = vec3(noise3(p * 3.0 + drift),
                     noise3(p * 3.0 + drift + 17.4),
                     noise3(p * 3.0 + drift - 9.2));
    vec3 flowing = p * 5.2 + warp * 1.55 + drift;
    float convection = fbm3(flowing);
    float filaments = 1.0 - abs(noise3(flowing * 2.3 + vec3(0.0, uTime * .06, 0.0))) * 3.1;
    float granules = noise3(p * 52.0 + warp * 3.0 + drift * 1.5);
    float activity = clamp(.53 + convection * .86 + granules * .11, 0.0, 1.0);
    float thermalField = noise3(p * 2.2 + drift * .37) * .35
      + noise3(flowing * .52) * .18 + p.y * .30;
    float whiteHeat = smoothstep(.015, .22, thermalField);
    vec3 ochre = vec3(.54, .19, .018);
    vec3 amber = vec3(1.15, .55, .045);
    vec3 cream = vec3(1.9, 1.25, .29);
    vec3 color = mix(ochre, amber, smoothstep(.13, .62, activity));
    color = mix(color, cream, smoothstep(.48, .92, activity));
    color += vec3(2.1, 1.6, .38) * whiteHeat * whiteHeat;
    color += vec3(.18, .12, .025) * pow(max(filaments, 0.0), 10.0);
    vec3 eye = normalize(mix(-vViewPosition, vec3(0,0,1), vOrthographic));
    float facing = max(dot(normalize(vViewNormal), eye), 0.0);
    // Limb darkening and a warm, bright photosphere establish spherical volume.
    color *= .60 + .40 * pow(facing, .38);
    color += vec3(.18, .085, .012) * pow(1.0 - facing, 2.4);
    gl_FragColor = vec4(color, uOpacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const CORONA_VERTEX = /* glsl */ `
  varying vec3 vLocalPosition;
  varying vec3 vLocalCamera;
  varying vec3 vLocalViewAxis;
  varying float vOrthographic;
  void main() {
    vLocalPosition = position;
    mat4 cameraToLocal = inverse(modelViewMatrix);
    vLocalCamera = (cameraToLocal * vec4(0, 0, 0, 1)).xyz;
    vLocalViewAxis = normalize((cameraToLocal * vec4(0, 0, 1, 0)).xyz);
    vOrthographic = step(-.5, projectionMatrix[2][3]);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const CORONA_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uOpacity;
  varying vec3 vLocalPosition;
  varying vec3 vLocalCamera;
  varying vec3 vLocalViewAxis;
  varying float vOrthographic;
  ${NOISE}
  void main() {
    vec3 ray = normalize(vLocalPosition - vLocalCamera);
    ray = normalize(mix(ray, -vLocalViewAxis, vOrthographic));
    vec3 origin = mix(vLocalCamera, vLocalPosition - ray * 4.0, vOrthographic);
    float b = dot(origin, ray);
    float c = dot(origin, origin) - 1.35 * 1.35;
    float determinant = b * b - c;
    if (determinant < 0.0) discard;
    float impact2 = max(dot(origin, origin) - b * b, 0.0);
    // The photosphere owns the centre; this shell draws only its fine luminous
    // fringe. No billboard: rays integrate a 3D density field around the sphere.
    if (impact2 < .985 * .985) discard;
    float nearHit = -b - sqrt(determinant);
    float farHit = -b + sqrt(determinant);
    if (impact2 < 1.0) farHit = min(farHit, -b - sqrt(1.0 - impact2));
    float stride = (farHit - nearHit) / 12.0;
    float opticalDepth = 0.0;
    float wisps = 0.0;
    for (int i = 0; i < 12; i++) {
      vec3 q = origin + ray * (nearHit + (float(i) + .5) * stride);
      float radius = length(q);
      vec3 direction = q / radius;
      float altitude = max(radius - 1.0, 0.0);
      vec3 flow = direction * 7.5 + vec3(uTime * .05, -uTime * .12, 0.0);
      float turbulence = noise3(flow + noise3(flow * .51) * 1.8);
      // Irregular 3D magnetic knots make uneven prominences, with no polar
      // repetition or angular sine teeth that could read as a cogwheel.
      float prominence = smoothstep(.04, .29, turbulence);
      float reach = .032 + .16 * prominence;
      float filament = 1.0 - smoothstep(reach * .3, reach, altitude);
      float envelope = exp(-altitude * 37.0);
      float patchiness = .32 + .68 * smoothstep(-.12, .20, noise3(flow * .63 + 4.7));
      float density = (envelope * .42 + filament * prominence * .27) * patchiness;
      density *= 1.0 - smoothstep(1.27, 1.35, radius);
      opticalDepth += density * stride * 6.0;
      wisps += filament * prominence * stride;
    }
    float alpha = clamp(1.0 - exp(-opticalDepth), 0.0, .85) * uOpacity;
    if (alpha < .001) discard;
    vec3 color = mix(vec3(1.1, .53, .065), vec3(2.2, 1.52, .45), clamp(wisps * 4.0, 0.0, 1.0));
    gl_FragColor = vec4(color, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** A unit photosphere with a ray-marched, irregular corona inside radius 1.35. */
export function createSun() {
  const object = new THREE.Group();
  object.name = 'Live 3D solar plasma';
  const coreUniforms = { uTime: { value: 0 }, uOpacity: { value: 1 } };
  const coronaUniforms = { uTime: { value: 0 }, uOpacity: { value: 1 } };
  const coreMaterial = new THREE.ShaderMaterial({
    uniforms: coreUniforms, vertexShader: SUN_VERTEX, fragmentShader: SUN_FRAGMENT,
    transparent: true, depthWrite: true,
  });
  const coronaMaterial = new THREE.ShaderMaterial({
    uniforms: coronaUniforms, vertexShader: CORONA_VERTEX, fragmentShader: CORONA_FRAGMENT,
    transparent: true, depthWrite: false, blending: THREE.NormalBlending,
    // The shell integrates its own front/back volume once from its front face.
    side: THREE.FrontSide,
  });
  const coreGeometry = new THREE.SphereGeometry(1, 72, 48);
  const coronaGeometry = new THREE.SphereGeometry(1.35, 64, 40);
  const core = new THREE.Mesh(coreGeometry, coreMaterial);
  const corona = new THREE.Mesh(coronaGeometry, coronaMaterial);
  core.name = 'Convective photosphere';
  corona.name = 'Volumetric solar corona';
  corona.renderOrder = 1;
  const halo = createOpticalHalo(true);
  object.add(core, corona, halo.object);
  return {
    object,
    update(time = 0, options = {}) {
      coreUniforms.uTime.value = coronaUniforms.uTime.value = halo.uniforms.uTime.value = time;
      // A slow axial rotation remains distinct from the faster plasma flow.
      core.rotation.y = time * .07;
      core.rotation.z = .12;
      corona.rotation.y = time * .07;
      corona.rotation.z = .12;
      if (Number.isFinite(options.opacity)) {
        coreUniforms.uOpacity.value = coronaUniforms.uOpacity.value = halo.uniforms.uOpacity.value = options.opacity;
      }
    },
    dispose() {
      coreGeometry.dispose(); coronaGeometry.dispose();
      coreMaterial.dispose(); coronaMaterial.dispose();
      halo.dispose();
    },
  };
}
