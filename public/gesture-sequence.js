/**
 * Observable interaction sequence reconstructed from the supplied video.
 * This module has no DOM, camera, rendering or timer dependencies.
 * All points are already mirrored, canvas-normalized SCREEN coordinates.
 * Call update() with fresh hand observations and time in monotonic seconds.
 */
const clamp = (n, a = 0, b = 1) => Math.max(a, Math.min(b, n));
const copy = (p) => ({ x: p.x, y: p.y });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const point = (p, fallback) => p && Number.isFinite(p.x) && Number.isFinite(p.y)
  ? { x: clamp(p.x), y: clamp(p.y) } : copy(fallback);

/** Durations are seconds, screen distances are fractions of the canvas. */
export const SEQUENCE_DEFAULTS = Object.freeze({
  lostGrace: 0.15,
  openArmDuration: 0.08,
  summonDuration: 0.22,
  grabDuration: 0.06,
  releaseDuration: 0.045,
  swipeWindow: 0.48,
  swipeMinDuration: 0.06,
  swipeMinDistance: 0.13,
  swipeHandDistance: 1.45,
  swipeMinSpeed: 0.38,
  swipeHorizontalRatio: 1.7,
  swipeCooldown: 0.43,
  swipeReturnDistance: 0.10,
  grabRadius: 0.065,
  grabHandRadius: 0.8,
  cShapeMaxOpening: 1.45,
  cShapeMinStrength: 0.12,
  phasePullDeadZone: 0.025,
  phasePullVerticalTolerance: 0.20,
  phaseMinSpan: 0.18,
  phaseMaxSpan: 0.72,
  phasePullTravelRatio: 0.65,
  phaseSwipeDistance: 0.20,
  phaseUnfoldDuration: 1.10,
  phaseCollapseDuration: 0.55,
  liftMinLeft: 0.14,
  liftHandLeft: 1.35,
  liftMinUp: 0.15,
  liftHandUp: 1.50,
  lReleaseOpening: 1.35,
  lReleaseGrowth: 1.18,
  panGrowDuration: 0.45,
  panDropHandLeft: 1.25,
  panDropHandDown: 2.7,
  burstFistDuration: 0.09,
  burstOpenWindow: 0.48,
  burstRadius: 0.20,
  burstHandRadius: 2.8,
});

const HINTS = {
  idle: '四指收拢握拳，拇指可伸出，停留片刻召出星星',
  star: '松开拳头，像原片一样把手从左向右横扫',
  sun: '手收回左边，伸出食指和拇指，再向右横扫',
  moon: '用拇指和食指在月球旁形成 C 形，夹住月球',
  moonHeld: '夹紧缩小并移到右侧，再伸直食指、张开拇指释放',
  moonReleased: '月球已停住，五指张开向左横扫，展开五个月相',
  phases: '月相会自行展开；回到最右端，用拇指和食指夹住满月',
  phaseHeld: '夹住小月球向左上方举起，再张开拇指与食指',
  pan: '黑胶唱片已悬停，在唱片旁握拳，再张开五指使它散开',
  burst: '演示结束，点击重来可重新开始',
};

export class GestureSequence {
  constructor({ onEvent = () => {}, thresholds = {} } = {}) {
    this.onEvent = onEvent;
    this.config = { ...SEQUENCE_DEFAULTS, ...thresholds };
    this.reset();
  }

  reset(time = 0) {
    this.stage = 'idle';
    this.mode = null;
    this.target = { x: 0.43, y: 0.58 };
    this.scale = 1;
    this.phaseProgress = 0;
    this.phaseAnchor = copy(this.target);
    this.phaseSpan = 0.72;
    this.panProgress = 0;
    this.panOrigin = null;
    this.releaseTarget = null;
    this.releaseOrigin = null;
    this.releaseProgress = 0;
    this.releaseScale = 1;
    this.burstTarget = null;
    this.held = false;
    this.tracked = false;
    this.burst = false;
    this._time = Number.isFinite(time) ? time : 0;
    this._stageAt = this._time;
    this._lastUpdate = null;
    this._lastTracked = null;
    this._missingSince = null;
    this._timers = Object.create(null);
    this._swipeSamples = [];
    this._swipeReady = true;
    this._swipeEnd = null;
    this._summonArmed = false;
    this._needsReacquire = false;
    this._grabStart = null;
    this._minHeldOpeningRatio = Infinity;
    this._pullOrigin = null;
    this._pullLast = null;
    this._pullDistance = 0;
    this._pullBaseDistance = 0;
    this._pullSegmentStartX = null;
    this._collapseFrom = 0;
    this._liftReady = false;
    this._burstArmed = false;
    this._fistLastAt = null;
    this.aspectRatio = 1;
    return this.snapshot();
  }

  snapshot() {
    let hint = HINTS[this.stage];
    if (this._needsReacquire) hint = '跟踪曾中断，请在停住的月球旁重新夹住它';
    else if (!this.tracked && this.stage !== 'burst') hint = '把手放回镜头内；当前天体会留在原位';
    return {
      stage: this.stage,
      mode: this.mode,
      visible: this.mode !== null && this.stage !== 'burst',
      target: copy(this.target),
      scale: this.scale,
      phaseProgress: this.phaseProgress,
      phaseAnchor: copy(this.phaseAnchor),
      phaseSpan: this.phaseSpan,
      held: this.held,
      panProgress: this.panProgress,
      panOrigin: this.panOrigin && copy(this.panOrigin),
      burst: this.burst,
      tracked: this.tracked,
      releaseTarget: this.releaseTarget && copy(this.releaseTarget),
      releaseOrigin: this.releaseOrigin && copy(this.releaseOrigin),
      releaseProgress: this.releaseProgress,
      releaseScale: this.releaseScale,
      burstTarget: this.burstTarget && copy(this.burstTarget),
      interaction: this._needsReacquire ? 'reacquire'
        : this.held ? 'holding'
          : this.stage === 'phases' ? 'pulling'
            : this._burstArmed ? 'burst-ready' : 'waiting',
      hint,
      time: this._time,
    };
  }

  /**
   * Advance visual animations between NEW model observations. Never feed a
   * cached hand into update() on each render frame: that invents evidence for
   * a stable gesture. tick() clears event pulses and expires stale tracking,
   * but never updates observation timestamps or starts/advances gesture tests.
   */
  tick(time) {
    if (Number.isFinite(time)) this._time = Math.max(this._time, time);
    this.burst = false;
    this._animate();
    if (this._lastTracked !== null && this._time - this._lastTracked > this.config.lostGrace) {
      this.tracked = false;
      if (this._missingSince === null) this._missingSince = this._time;
      this._breakTracking(true);
    }
    return this.snapshot();
  }

  update(input, time) {
    const nextTime = Number.isFinite(time) ? time : this._time;
    this._time = Math.max(this._time, nextTime);
    this.burst = false;
    const gap = this._lastUpdate === null ? 0 : this._time - this._lastUpdate;
    this._lastUpdate = this._time;
    // A stalled camera is a tracking break even if no null sample was sent.
    if (gap > this.config.lostGrace) this._breakTracking(true);
    this._animate();

    if (!input?.palm) {
      this.tracked = false;
      if (this._missingSince === null) this._missingSince = this._time;
      this._breakTracking(this._lastTracked !== null
        && this._time - this._lastTracked > this.config.lostGrace);
      return this.snapshot();
    }

    const wasMissing = this._missingSince !== null;
    const missingLong = wasMissing && this._lastTracked !== null
      && this._time - this._lastTracked > this.config.lostGrace;
    if (missingLong) this._breakTracking(true);
    this._missingSince = null;
    this._lastTracked = this._time;
    this.tracked = true;
    const hand = this._normalize(input);

    if (this.stage === 'burst') return this.snapshot();
    if (this._needsReacquire && this.held) {
      if (this._dwell('reacquire', this._near(hand, this.target) && this._grip(hand), this.config.grabDuration)) {
        this._needsReacquire = false;
        // This is a newly confirmed, spatially bounded grip observation. Keep
        // its position even if another detector dropout follows immediately.
        this.target = copy(hand.pinchCenter);
        this.scale = this._heldScale(hand);
        this._rememberGrip(hand);
        this._timers = Object.create(null);
      }
      return this.snapshot();
    }

    switch (this.stage) {
      case 'idle': this._idle(hand); break;
      case 'star':
      case 'sun': this._sweep(hand); break;
      case 'moon':
        if (this._dwell('grab', this._near(hand, this.target) && this._grip(hand), this.config.grabDuration)) {
          this._grab(hand, 'moonHeld');
        }
        break;
      case 'moonHeld': this._heldMoon(hand); break;
      case 'moonReleased':
      case 'phases': this._phases(hand); break;
      case 'phaseHeld': this._heldPhase(hand); break;
      case 'pan': this._pan(hand); break;
    }
    return this.snapshot();
  }

  _normalize(input) {
    this.aspectRatio = Math.max(0.5, Number(input.aspectRatio) || 1);
    const palm = point(input.palm, this.target);
    const index = point(input.index, input.pinchCenter || palm);
    const thumb = point(input.thumb, input.pinchCenter || palm);
    const fingers = input.fingerStates || null;
    return {
      ...input,
      palm, index, thumb,
      pinchCenter: point(input.pinchCenter, { x: (index.x + thumb.x) / 2, y: (index.y + thumb.y) / 2 }),
      handSize: clamp(Number.isFinite(input.handSize) ? input.handSize : 0.085, 0.025, 0.24),
      pinchStrength: clamp(Number.isFinite(input.pinchStrength) ? input.pinchStrength : input.pinch ? 1 : 0),
      spread: clamp(input.spread || 0),
      fingerStates: fingers,
      extendedCount: fingers ? ['index', 'middle', 'ring', 'pinky'].filter((name) => fingers[name]).length : null,
      opening: Math.hypot(index.x-thumb.x,(index.y-thumb.y)/this.aspectRatio),
    };
  }

  _dwell(key, active, duration) {
    if (!active) { delete this._timers[key]; return false; }
    if (this._timers[key] === undefined) this._timers[key] = this._time;
    return this._time - this._timers[key] + 1e-7 >= duration;
  }

  _setStage(stage, mode = this.mode) {
    const previousStage = this.stage;
    const previousMode = this.mode;
    this.stage = stage;
    this.mode = mode;
    this._stageAt = this._time;
    this._timers = Object.create(null);
    this._swipeSamples = [];
    this._emit({ type: 'stage', previousStage, previousMode });
    if (previousMode !== mode) this._emit({ type: 'mode', previousStage, previousMode });
  }

  _emit(event) {
    this.onEvent({ ...event, stage: this.stage, mode: this.mode, time: this._time, target: copy(this.target) });
  }

  _breakTracking(long) {
    // Missing observations never count toward stable-gesture timers. A short
    // detector dropout may preserve REAL observed swipe points; no position is
    // interpolated, and _sweep still checks elapsed time and maximum speed.
    this._timers = Object.create(null);
    this._pullLast = null;
    this._burstArmed = false;
    this._fistLastAt = null;
    if (long) {
      this._swipeSamples = [];
      if (this.held) this._needsReacquire = true;
      if (this.stage === 'idle') this._summonArmed = false;
    }
  }

  _near(hand, target, radius = this.config.grabRadius, handRadius = this.config.grabHandRadius) {
    return Math.hypot(hand.pinchCenter.x-target.x,(hand.pinchCenter.y-target.y)/this.aspectRatio) <= Math.max(radius, hand.handSize * handRadius);
  }

  _grip(hand) {
    if (hand.openPalm || hand.victory) return false;
    if (!this.held && hand.fist) return false;
    if (hand.pinch) return true;
    if (hand.fist && (!this.held || hand.opening < hand.handSize * 0.23)) return false;
    // The video's C-shaped grasp is visibly wider than fingertip contact.
    const curledOthers = hand.fingerStates
      ? ['middle', 'ring', 'pinky'].filter((name) => !hand.fingerStates[name]).length >= 2
      : Boolean(hand.pointing) || hand.pinchStrength >= this.config.cShapeMinStrength;
    return curledOthers
      && hand.opening <= hand.handSize * this.config.cShapeMaxOpening + 1e-7
      && (hand.pinchStrength >= this.config.cShapeMinStrength || hand.fingerStates?.thumb || hand.pointing);
  }

  _openRelease(hand) {
    if (hand.pinch || hand.victory) return false;
    if (hand.openPalm || hand.extendedCount >= 3 && hand.opening >= hand.handSize * 0.65) return true;
    // The source's opened hand intermittently loses index/ring extension in
    // the model. Two visible extended fingers plus a genuinely wider aperture
    // can preserve release/pull evidence; a still valid C grip cannot release.
    const ratio = hand.opening / hand.handSize;
    return !hand.fist && !this._grip(hand) && hand.extendedCount >= 2
      && hand.pinchStrength <= 0.15 && ratio >= 0.85
      && (!this.held || ratio >= this._minHeldOpeningRatio * 1.45);
  }

  _lRelease(hand) {
    const f = hand.fingerStates;
    return this._openRelease(hand) || (!this._grip(hand) && !hand.pinch && f?.thumb && f.index
      && !f.middle && !f.ring && !f.pinky
      && hand.opening / hand.handSize >= Math.max(this.config.lReleaseOpening,
        this._minHeldOpeningRatio * this.config.lReleaseGrowth));
  }

  _moonRelease(hand) {
    if (this._openRelease(hand)) return true;
    // Frames 645–646 release with index + thumb open, the other fingers curled.
    const ratio=hand.opening/hand.handSize;
    return !hand.pinch && !hand.fist && !hand.victory && hand.pinchStrength<=.18 && hand.fingerStates?.index && hand.fingerStates.thumb
      && ['middle','ring','pinky'].filter(name=>!hand.fingerStates[name]).length>=2
      && ratio>=.75 && ratio>=this._minHeldOpeningRatio*1.6;
  }

  _idle(hand) {
    if (this._dwell('openArm', hand.openPalm && !hand.pinch, this.config.openArmDuration)) this._summonArmed = true;
    const closed = hand.fist || (!hand.openPalm && !hand.victory && hand.extendedCount === 0 && hand.pinchStrength > 0.68);
    if (this._dwell('summon', closed, this.config.summonDuration)) {
      // Frame 483–491: the star appears just below/right of the closed fingers,
      // then stays put when the fist moves away. No prior open-palm lock.
      this.target = {x:clamp(hand.pinchCenter.x+.018,.08,.92),y:clamp(hand.pinchCenter.y+.035,.12,.84)};
      this.phaseAnchor = copy(this.target);
      this._swipeReady = true;
      this._setStage('star', 'star');
    }
  }

  _sweep(hand) {
    const t = this._time;
    const c = this.config;
    if (!this._swipeReady) {
      const returned = this._swipeEnd && hand.palm.x <= this._swipeEnd.x - Math.max(c.swipeReturnDistance, hand.handSize);
      if (returned && t - this._stageAt >= c.swipeCooldown) {
        this._swipeReady = true;
        this._swipeSamples = [];
      } else return;
    }
    // Spatial motion is the evidence for a swipe. The source detector briefly
    // labels the moving hand as victory or misses index extension; neither
    // should erase an otherwise clear rightward sweep. A stationary V still
    // cannot pass the direction, displacement, speed and path checks below.
    const pose = !hand.pinch && !hand.fist;
    if (!pose || t - this._stageAt < c.swipeCooldown) { this._swipeSamples = []; return; }
    const sample = { ...hand.palm, index:copy(hand.index), thumb:copy(hand.thumb), time: t };
    const last = this._swipeSamples.at(-1);
    if (last && (t - last.time > c.lostGrace || distance(last, sample) / Math.max(t - last.time, 0.001) > 5.5)) {
      this._swipeSamples = [];
    }
    this._swipeSamples.push(sample);
    this._swipeSamples = this._swipeSamples.filter((entry) => t - entry.time <= c.swipeWindow);
    const minDistance = Math.max(c.swipeMinDistance, hand.handSize * c.swipeHandDistance);
    for (let i = 0; i < this._swipeSamples.length - 1; i++) {
      const start = this._swipeSamples[i];
      const dt = t - start.time;
      const dx = sample.x - start.x;
      const dy = Math.abs(sample.y - start.y);
      if (dt < c.swipeMinDuration || dx < minDistance || dx / dt < c.swipeMinSpeed
        || dx < dy * c.swipeHorizontalRatio) continue;
      const path = this._swipeSamples.slice(i);
      let backtrack = 0;
      for (let j = 1; j < path.length; j++) backtrack += Math.max(0, path[j - 1].x - path[j].x);
      if (backtrack > dx * 0.25) continue;
      // In the clip the hand sweeps THROUGH the object. A far-away wave is
      // not a hit. Test fingertip paths too: the palm sits below the sphere.
      const hitRadius=Math.max(.055,hand.handSize*.70);
      const metric=p=>({x:p.x,y:p.y/this.aspectRatio});
      const center=metric(this.target);
      const segmentDistance=(a,b)=>{a=metric(a);b=metric(b);const vx=b.x-a.x,vy=b.y-a.y;const u=clamp(((center.x-a.x)*vx+(center.y-a.y)*vy)/(vx*vx+vy*vy||1));return Math.hypot(center.x-a.x-vx*u,center.y-a.y-vy*u);};
      let intersects=false;
      for(let j=1;j<path.length&&!intersects;j++)for(const key of ['palm','index','thumb']){
        const a=key==='palm'?path[j-1]:path[j-1][key],b=key==='palm'?path[j]:path[j][key];
        if(segmentDistance(a,b)<=hitRadius)intersects=true;
      }
      if(!intersects)continue;
      this._swipeEnd = copy(sample);
      this._swipeReady = false;
      if (this.stage === 'star') this._setStage('sun', 'sun');
      else this._setStage('moon', 'moon');
      return;
    }
  }

  _grab(hand, stage) {
    this.held = true;
    this._needsReacquire = false;
    this._grabStart = copy(hand.pinchCenter);
    this._minHeldOpeningRatio = hand.opening / hand.handSize;
    this.target = copy(hand.pinchCenter);
    this.scale = this._heldScale(hand);
    this._liftReady = false;
    this._collapseFrom = this.phaseProgress;
    this._setStage(stage, 'moon');
  }

  _heldScale(hand) {
    // Source 619–643 already shows a small orb in a visible C aperture;
    // requiring fingertip contact would keep the moon much too large.
    const aperture=clamp((hand.opening/hand.handSize-.34)/.46);
    return clamp(.035+.965*Math.pow(Math.min(aperture,1-hand.pinchStrength),1.05),.035,1);
  }

  _rememberGrip(hand) {
    this._minHeldOpeningRatio = Math.min(this._minHeldOpeningRatio, hand.opening / hand.handSize);
  }

  _follow(hand) {
    if (!this._grip(hand)) return false;
    // A returning hand cannot teleport a held moon across the canvas.
    if (!this._near(hand, this.target, 0.16, 2.6)) {
      this._needsReacquire = true;
      return false;
    }
    this.target = copy(hand.pinchCenter);
    this.scale = this._heldScale(hand);
    this._rememberGrip(hand);
    return true;
  }

  _heldMoon(hand) {
    const releasing=this._moonRelease(hand);
    if(!releasing)this._follow(hand);
    if (this._needsReacquire) return;
    if (this._dwell('release', releasing && this._near(hand, this.target), this.config.releaseDuration)) {
      // Use the LAST GRIPPED point, never the opened palm or a fixed screen point.
      this.releaseOrigin = copy(this.target);
      this.releaseScale = this.scale;
      this.releaseProgress = 0;
      this.target = {x:clamp(this.target.x+.03,.06,.94),y:this.target.y};
      this.releaseTarget = copy(this.target);
      this.phaseAnchor = copy(this.target);
      this.phaseSpan = Math.min(this.config.phaseMaxSpan, Math.max(0.06, this.phaseAnchor.x - 0.055));
      this._pullOrigin = copy(hand.palm);
      this._pullLast = copy(hand.palm);
      this._pullSegmentStartX = hand.palm.x;
      this._pullBaseDistance = 0;
      this.held = false;
      this.scale = 1;
      this._setStage('moonReleased', 'moon');
    }
  }

  _phases(hand) {
    if (this.stage === 'phases' && this.phaseProgress >= 0.72
      && this._dwell('phaseGrab', this._near(hand, this.phaseAnchor) && this._grip(hand), this.config.grabDuration)) {
      this._grab(hand, 'phaseHeld');
      return;
    }
    if (this.stage === 'phases') return;
    if (!this._openRelease(hand)) { this._pullLast = null; return; }
    // After loss or a closed hand, restart at the observed point without
    // charging the unobserved distance to the moon-phase expansion.
    if (!this._pullLast) {
      this._pullLast = copy(hand.palm);
      this._pullSegmentStartX = hand.palm.x;
      this._pullBaseDistance = this._pullDistance;
      return;
    }
    const dx = this._pullLast.x - hand.palm.x;
    const dy = Math.abs(this._pullLast.y - hand.palm.y);
    this._pullLast = copy(hand.palm);
    if (dx <= 0 || dx < dy * 1.2 || Math.abs(hand.palm.y - this._pullOrigin.y) > this.config.phasePullVerticalTolerance) return;
    // The source palm travels about .50 screen widths while the five moons
    // span about .72, so a literal one-to-one drag would never fully unfold.
    // Use the furthest observed left displacement, not accumulated positive
    // deltas: waving back and forth must not ratchet five phases into view.
    const observedPull = this._pullBaseDistance
      + Math.max(0, this._pullSegmentStartX - hand.palm.x - this.config.phasePullDeadZone);
    this._pullDistance = Math.max(this._pullDistance, observedPull);
    if (this._pullDistance >= this.config.phaseSwipeDistance) {
      this.phaseProgress = 0;
      this._setStage('phases', 'phases');
    }
  }

  _heldPhase(hand) {
    if (this._follow(hand)) {
      const left = this._grabStart.x - this.target.x;
      const up = this._grabStart.y - this.target.y;
      if (left >= Math.max(this.config.liftMinLeft, hand.handSize * this.config.liftHandLeft)
        && up >= Math.max(this.config.liftMinUp, hand.handSize * this.config.liftHandUp)) this._liftReady = true;
    }
    if (this._needsReacquire) return;
    if (this._dwell('panRelease', this._liftReady && this._lRelease(hand) && this._near(hand, this.target), this.config.releaseDuration)) {
      this.releaseTarget = copy(this.target);
      this.panOrigin = copy(this.target);
      // Source frames 803–811: the released light settles below-left of the
      // raised fingers before the pan encloses it. Keep that derived center
      // fixed, and let the renderer interpolate from panOrigin to target.
      this.target = {
        x: clamp(this.panOrigin.x - hand.handSize * this.config.panDropHandLeft, 0.06, 0.94),
        y: clamp(this.panOrigin.y + hand.handSize * this.config.panDropHandDown, 0.10, 0.90),
      };
      this.held = false;
      this.scale = 1;
      this.phaseProgress = 0;
      this.panProgress = 0;
      this._setStage('pan', 'pan');
    }
  }

  _pan(hand) {
    const near = Math.hypot(hand.palm.x-this.target.x,(hand.palm.y-this.target.y)/this.aspectRatio) <= Math.max(this.config.burstRadius, hand.handSize * this.config.burstHandRadius);
    if (this._dwell('burstFist', near && hand.fist, this.config.burstFistDuration)) this._burstArmed = true;
    if (hand.fist && this._burstArmed) this._fistLastAt = this._time;
    if (!near || this._fistLastAt !== null && this._time - this._fistLastAt > this.config.burstOpenWindow) {
      this._burstArmed = false;
      this._fistLastAt = null;
    }
    if (near && this._burstArmed && this._fistLastAt !== null && hand.openPalm && !hand.pinch) {
      this.burstTarget = copy(this.target);
      this.burst = true;
      this._burstArmed = false;
      this._setStage('burst', null);
      this._emit({ type: 'burst' });
    }
  }

  _animate() {
    if(this.stage === 'moonReleased') {
      this.releaseProgress=clamp((this._time-this._stageAt)/.6);
    } else if (this.stage === 'phases') {
      this.phaseProgress = clamp((this._time-this._stageAt)/this.config.phaseUnfoldDuration);
    } else if (this.stage === 'phaseHeld') {
      this.phaseProgress = this._collapseFrom * (1 - clamp((this._time - this._stageAt) / this.config.phaseCollapseDuration));
    } else if (this.stage === 'pan') {
      this.panProgress = clamp((this._time - this._stageAt) / this.config.panGrowDuration);
    }
  }
}

export default GestureSequence;
