// Renderer, scene, lighting from arena.json (sun, sky, fog), ACES tone mapping, sun shadows following the action.
import * as THREE from "three";

const col = (c, fallback) => {
  if (c == null) return new THREE.Color(fallback);
  if (Array.isArray(c)) return new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
  return new THREE.Color(c);
};

export class Renderer {
  /** mobile: phone / tablet GPU budget (no supersampling, smaller sun shadow map) */
  constructor(container, { mobile = false } = {}) {
    const r = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    r.setPixelRatio(Math.min(devicePixelRatio, mobile ? 1 : 1.5));
    this.shadowSize = mobile ? 1024 : 2048;
    r.setSize(innerWidth, innerHeight);
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(r.domElement);
    this.renderer = r;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 3000);
    addEventListener("resize", () => {
      r.setSize(innerWidth, innerHeight);
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
    });
  }

  get dom() { return this.renderer.domElement; }

  setupEnvironment(arena) {
    const s = this.scene;
    // sky.color is a UE FLinearColor (linear); fog.color comes from an sRGB hex (VolumetricFogAlbedo)
    const skyC = arena.sky?.color ? new THREE.Color().setRGB(...arena.sky.color) : new THREE.Color(0x8a9bb0);
    const fog = arena.fog || {};
    const fogC = col(fog.color, skyC.getHex());
    s.background = skyC.clone();
    s.fog = fog.density ? new THREE.FogExp2(fogC, fog.density) : new THREE.Fog(fogC, fog.near ?? 30, fog.far ?? 400);
    this.camera.far = Math.max(600, (fog.far ?? 400) * 1.5);
    this.camera.updateProjectionMatrix();

    // image-based light: PMREM of a sky-colored gradient dome (sky above, fog colour at horizon, darker ground)
    const envScene = new THREE.Scene();
    const ground = fogC.clone().multiplyScalar(0.35);
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(10, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        uniforms: { top: { value: skyC }, mid: { value: fogC }, bot: { value: ground } },
        vertexShader: "varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }",
        fragmentShader: "uniform vec3 top, mid, bot; varying vec3 vP; void main(){ float h = normalize(vP).y;" +
          " vec3 c = h > 0. ? mix(mid, top, pow(h, .6)) : mix(mid, bot, pow(-h, .5)); gl_FragColor = vec4(c, 1.); }",
      }),
    );
    envScene.add(dome);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(envScene, 0.04).texture;
    this.scene.environmentIntensity = 0.6;
    pmrem.dispose();

    const sun = arena.sun || {};
    const dir = new THREE.Vector3(...(sun.direction || [-0.4, -1, -0.3])).normalize();
    // contract: direction the light travels (towards the ground). Light object sits opposite to it.
    if (dir.y > 0) dir.negate();
    this.sunDir = dir;
    const light = new THREE.DirectionalLight(col(sun.color, 0xfff1dc), sun.intensity ?? 3);
    light.castShadow = true;
    light.shadow.mapSize.set(this.shadowSize, this.shadowSize);
    const S = 22;
    Object.assign(light.shadow.camera, { left: -S, right: S, top: S, bottom: -S, near: 1, far: 200 });
    light.shadow.bias = -0.0004;
    light.shadow.normalBias = 0.03;
    s.add(light, light.target);
    this.sun = light;
    this.hemi = new THREE.HemisphereLight(skyC, ground, 0.35);
    s.add(this.hemi);
  }

  /** keeps the shadow frustum centred on `focus` (Vector3) */
  followSun(focus) {
    if (!this.sun) return;
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(this.sunDir, -80);
  }

  render() { this.renderer.render(this.scene, this.camera); }
}
