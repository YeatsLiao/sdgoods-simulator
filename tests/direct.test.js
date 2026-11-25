import test from "node:test";
import assert from "node:assert/strict";

import {
  DirectStreamPlayer,
  bufferedSeconds,
  isDirectPlayable,
  parseStreamUrl,
  stationLabel,
} from "../web/js/audio/direct.js";
import { AudioEngine } from "../web/js/audio/engine.js";

// storage.js 走 localStorage；这里给一份内存实现，缓存行为才能在 Node 里断言。
async function withStorage(run) {
  const store = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  try {
    // 必须 await：否则异步体还在跑时就先把 localStorage 摘掉了。
    return await run(store);
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
}

function stationRow(overrides = {}) {
  return {
    stationuuid: "uuid-1",
    name: "CNR&#12288;中国之声",
    url: "https://example.invalid/live.mp3",
    url_resolved: "https://cdn.example.invalid/live.mp3",
    codec: "MP3",
    bitrate: 64,
    countrycode: "cn",
    ...overrides,
  };
}

class FakeRanges {
  constructor(list) {
    this.list = list;
  }

  get length() {
    return this.list.length;
  }

  start(index) {
    if (index >= this.list.length) throw new Error("out of range");
    return this.list[index][0];
  }

  end(index) {
    if (index >= this.list.length) throw new Error("out of range");
    return this.list[index][1];
  }
}

class FakeAudioElement {
  constructor() {
    this.listeners = new Map();
    this.attributes = new Map();
    this.buffered = new FakeRanges([]);
    this.currentTime = 0;
    this.volume = 1;
    this.preload = "";
    this.error = null;
    this.playResult = Promise.resolve();
    this.playCalls = 0;
    this.pauseCalls = 0;
    this.loadCalls = 0;
  }

  addEventListener(type, handler) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  get src() {
    return this.attributes.get("src") ?? "";
  }

  set src(value) {
    this.attributes.set("src", String(value));
  }

  load() {
    this.loadCalls += 1;
  }

  play() {
    this.playCalls += 1;
    return this.playResult;
  }

  pause() {
    this.pauseCalls += 1;
  }

  fire(type) {
    for (const handler of this.listeners.get(type) ?? []) handler({ target: this });
  }
}

function playerWith(factory) {
  const created = [];
  const player = new DirectStreamPlayer({
    createElement: () => {
      const element = factory ? factory() : new FakeAudioElement();
      created.push(element);
      return element;
    },
  });
  return { player, created };
}

test("parseStreamUrl 只认播放器报出的那一路流地址", () => {
  const url = "https://lhttp.qtfm.cn/live/15318317/64k.mp3";
  assert.equal(parseStreamUrl(`I (12345) radio_player: net: connected, streaming: ${url}
`), url);
  assert.equal(parseStreamUrl(`I (1) radio_player: http 302 -> ${url}`), url);
  assert.equal(parseStreamUrl("I (1) radio_player: net: connected, streaming"), "", "旧固件没带地址时不猜");
  assert.equal(
    parseStreamUrl("I (1) radio_catalog: GET https://de1.api.radio-browser.info/json/stations/search -> 200, 4096 bytes"),
    "",
    "取电台列表不是音频流",
  );
  assert.equal(parseStreamUrl(`streaming: ${url}
I (2) radio_player: playing: 48000 Hz ch=2 MP3`), url);
  assert.equal(parseStreamUrl(""), "");
  // 尾巴缓冲里留着上一台，切台后必须取最后一条，否则永远跟着旧地址。
  assert.equal(
    parseStreamUrl(`streaming: ${url}
I (20000) radio_player: net: connected, streaming: https://lhttp.qingting.fm/live/4804/64k.mp3
`),
    "https://lhttp.qingting.fm/live/4804/64k.mp3",
  );
  assert.equal(
    parseStreamUrl(`I (1) radio_player: http 301 -> https://a/1.mp3
I (2) radio_player: http 302 -> https://a/2.mp3`),
    "https://a/2.mp3",
  );
  // 一行被拆成两块时，靠调用方拼的尾巴接起来。
  assert.equal(parseStreamUrl("net: connected, stre" + "aming: https://a/3.mp3"), "https://a/3.mp3");
});

test("isDirectPlayable 拒绝浏览器解不了的容器", () => {
  assert.equal(isDirectPlayable("https://a/live.mp3"), true);
  assert.equal(isDirectPlayable("http://stm.rthk.hk/radio1"), true);
  assert.equal(isDirectPlayable("https://a/live.m3u8"), false);
  assert.equal(isDirectPlayable("https://a/manifest.mpd?x=1"), false);
  assert.equal(isDirectPlayable("https://a/playlist.pls"), false);
  assert.equal(isDirectPlayable("rtmp://a/live"), false);
  assert.equal(isDirectPlayable(""), false);
});

test("stationLabel 用地址本身命名，不替电台编名字", () => {
  assert.equal(stationLabel("https://lhttp.qtfm.cn/live/15318317/64k.mp3"), "lhttp.qtfm.cn / 64k.mp3");
  assert.equal(stationLabel("http://stm.rthk.hk/radio1"), "stm.rthk.hk / radio1");
  assert.equal(stationLabel("https://stream.example.com/"), "stream.example.com");
  assert.equal(stationLabel("不是地址"), "不是地址");
  assert.equal(stationLabel(""), "");
});

test("bufferedSeconds reads only the range still ahead of the playhead", () => {
  assert.equal(bufferedSeconds(null), 0);
  assert.equal(bufferedSeconds({ buffered: new FakeRanges([]), currentTime: 3 }), 0);
  assert.equal(bufferedSeconds({ buffered: new FakeRanges([[10, 42]]), currentTime: 12 }), 30);
  // 缓冲区间整体落后于播放头时不能报负数。
  assert.equal(bufferedSeconds({ buffered: new FakeRanges([[0, 4]]), currentTime: 9 }), 0);
  assert.equal(bufferedSeconds({ buffered: { get length() { throw new Error("不可读"); } } }), 0);
});

test("DirectStreamPlayer hands the output to the browser stream and reports buffering", async () => {
  await withStorage(async () => {
    const states = [];
    const { player, created } = playerWith();
    player.onChange((state) => states.push(state));
    assert.equal(player.active, false);
    assert.equal(states.length, 0);

    assert.equal(
      await player.play({ name: "中国之声", url: "https://cdn/live.mp3", codec: "MP3", bitrate: 64 }),
      true,
    );
    const element = created[0];
    assert.equal(created.length, 1);
    assert.equal(element.playCalls, 1);
    assert.equal(element.src, "https://cdn/live.mp3");
    assert.equal(element.preload, "auto");
    assert.equal(player.station.name, "中国之声");
    assert.equal(player.state.active, true);
    assert.equal(player.state.playing, true);
    assert.equal(player.state.buffering, false);
    assert.equal(player.state.error, "");
    assert.equal(player.lastStation.url, "https://cdn/live.mp3");

    element.buffered = new FakeRanges([[0, 32.4]]);
    element.currentTime = 1.9;
    element.fire("waiting");
    assert.equal(player.state.buffering, true);
    assert.equal(player.state.buffered, 30.5);
    assert.equal(player.state.playing, true, "补缓冲期间仍在播，面板不能报成停住");
    element.fire("canplay");
    assert.equal(player.state.buffering, false);

    player.stop();
    assert.equal(player.active, false);
    assert.equal(player.state.playing, false);
    assert.equal(player.state.name, "");
    assert.equal(element.pauseCalls, 1);
    assert.equal(element.getAttribute("src"), null);
    assert.equal(element.loadCalls, 1);
    assert.equal(states.length, 5, "缓存中→播放→补缓冲→缓冲好→停止，逐条通知面板");

    // 换台要先释放旧源，首路流则不该多走一次清场。
    assert.equal(element.pauseCalls, 1, "首路流不该先停自己");
    assert.equal(element.loadCalls, 1);

    // 暂停后继续：同一只元素，不重新取流。
    assert.equal(player.resume(), false, "stop 已交还站点，resume 无事可做");
    const kept = playerWith();
    await kept.player.play({ name: "B", url: "https://cdn/b.mp3" });
    kept.player.stop({ keepStation: true });
    assert.equal(kept.player.active, true);
    assert.equal(kept.player.resume(), true);
    assert.equal(kept.created[0].playCalls, 2);
    await kept.player.play({ name: "C", url: "https://cdn/c.mp3" });
    assert.equal(kept.created[0].pauseCalls, 2, "换台先停旧流");
    assert.equal(kept.created[0].getAttribute("src") !== null, true);
    assert.equal(kept.player.station.name, "C");
  });
});

test("DirectStreamPlayer 计的是连续播放时长，不是直播流的滚动窗口", async () => {
  await withStorage(async () => {
    let clock = 1000;
    const element = new FakeAudioElement();
    const player = new DirectStreamPlayer({ createElement: () => element, now: () => clock });
    await player.play({ name: "A", url: "https://a/1.mp3" });
    assert.equal(player.state.continuous, 0);
    clock += 4200;
    assert.equal(Math.round(player.state.continuous * 10) / 10, 4.2);
    assert.equal(player.state.gaps, 0);

    // 直播流的 buffered 一直是两三秒的滚动窗口，读成「已缓冲 2.3 秒」会被当成卡住。
    element.buffered = new FakeRanges([[0, 2.3]]);
    assert.equal(player.state.buffered, 2.3);

    element.fire("waiting");
    clock += 800;
    element.fire("playing");
    clock += 1000;
    assert.equal(player.state.gaps, 1, "断流后重新开播才计一次打断");
    assert.equal(Math.round(player.state.continuous), 1, "连续时长从恢复那一刻重新起算");

    element.fire("stalled");
    element.fire("canplay");
    assert.equal(player.state.gaps, 1, "没在播的时候补缓冲不算打断");

    player.stop();
    assert.equal(player.state.continuous, 0);
  });
});

test("DirectStreamPlayer reports why a stream will not play", async () => {
  await withStorage(async () => {
    const blocked = playerWith(() => {
      const element = new FakeAudioElement();
      element.playResult = Promise.reject(Object.assign(new Error("blocked"), { name: "NotAllowedError" }));
      return element;
    });
    assert.equal(await blocked.player.play({ name: "A", url: "https://a/1.mp3" }), false);
    assert.match(blocked.player.state.error, /自动播放/);
    assert.equal(blocked.player.state.playing, false);

    const messages = [];
    for (const code of [1, 2, 3, 4, 0]) {
      const element = new FakeAudioElement();
      const player = new DirectStreamPlayer({ createElement: () => element });
      await player.play({ name: "B", url: `https://b/${code}.mp3` });
      element.error = { code };
      element.fire("error");
      messages.push(player.state.error);
      assert.equal(player.state.playing, false);
      assert.equal(player.state.active, true, "失败后仍要留住是哪一路流，面板才说得出原因");
    }
    assert.match(messages[0], /中止/);
    assert.match(messages[1], /取流失败/);
    assert.match(messages[2], /解码失败/);
    assert.match(messages[3], /HLS/);
    assert.match(messages[4], /无法播放/);
    assert.equal(new Set(messages).size, 5);
  });
});

test("DirectStreamPlayer 切台时让路给新一路，不把浏览器的中断报成失败", async () => {
  await withStorage(async () => {
    const element = new FakeAudioElement();
    const player = new DirectStreamPlayer({ createElement: () => element, now: () => 0 });
    element.playResult = Promise.reject(Object.assign(new Error("interrupted"), { name: "AbortError" }));
    const pendingFirst = player.play({ url: "https://a/1.mp3" });
    // 设备在上一路还没落地时就切了台
    element.playResult = Promise.resolve();
    const pendingSecond = player.play({ url: "https://a/2.mp3" });
    assert.equal(await pendingFirst, false);
    assert.equal(await pendingSecond, true);
    assert.equal(player.state.error, "", "被取代的中断不是取流失败");
    assert.equal(player.station.url, "https://a/2.mp3");
    assert.equal(player.state.playing, true);
    assert.equal(element.pauseCalls, 1, "换台先停旧流");

    // 停止之后浏览器才报的错，不该把面板重新涂成失败
    player.stop();
    element.error = { code: 2 };
    element.fire("error");
    assert.equal(player.state.error, "");
    assert.equal(player.state.active, false);
  });
});

test("DirectStreamPlayer validates the address and follows volume and mute", async () => {
  await withStorage(async () => {
    let built = 0;
    const player = new DirectStreamPlayer({
      createElement: () => {
        built += 1;
        return new FakeAudioElement();
      },
    });
    assert.equal(await player.play({ url: "  " }), false);
    assert.equal(await player.play({ url: "ftp://a/b.mp3" }), false);
    assert.equal(built, 0, "地址不合法时不该创建元素");
    assert.match(player.state.error, /http/);
    assert.equal(player.resume(), false);

    const { player: followed, created } = playerWith();
    followed.setVolume(0.4);
    followed.setMuted(true);
    await followed.play({ name: "C", url: "https://c/1.mp3" });
    assert.equal(created[0].volume, 0, "静音先于播放生效");
    followed.setMuted(false);
    assert.equal(created[0].volume, 0.4);
    followed.setVolume(9);
    assert.equal(created[0].volume, 1, "音量夹在 0..1");
    assert.equal(followed.state.volume, 1);
    assert.equal(followed.state.muted, false);
    followed.setMuted(true);
    assert.equal(followed.state.volume, 0, "状态里的音量按实际输出算，静音时就是 0");

    const unsubscribers = [];
    let count = 0;
    for (let index = 0; index < 3; index++) {
      unsubscribers.push(followed.onChange(() => { count += 1; }));
    }
    followed.stop();
    assert.equal(count, 3);
    for (const unsubscribe of unsubscribers) unsubscribe();
    followed.stop();
    assert.equal(count, 3, "取消订阅后不再回调");
  });
});

// 直连取流期间，设备 PCM 必须整个不走解码与重采样：省的是浏览器自己的 CPU。
function installFakeAudio() {
  const nodes = [];
  let clock = 0;
  const previous = globalThis.performance;
  globalThis.performance = { now: () => clock, timeOrigin: 0 };

  class FakePort {
    constructor() {
      this.messages = [];
      this.onmessage = null;
    }

    postMessage(message) {
      this.messages.push(message);
    }

    close() {}
  }

  globalThis.AudioWorkletNode = function StubWorkletNode(_context, name) {
    this.name = name;
    this.port = new FakePort();
    this.connect = () => {};
    this.disconnect = () => {};
    nodes.push(this);
  };

  globalThis.AudioContext = function StubAudioContext() {
    this.state = "running";
    this.sampleRate = 48000;
    this.currentTime = 0;
    this.destination = { connect() {}, disconnect() {} };
    this.audioWorklet = { addModule: async () => {} };
    this.createGain = () => ({
      gain: { value: 1, setTargetAtTime() {} },
      connect: () => {},
      disconnect: () => {},
    });
    this.createBuffer = (_channels, frames) => ({
      length: frames,
      sampleRate: 48000,
      numberOfChannels: 2,
      getChannelData: () => new Float32Array(frames),
    });
    this.createBufferSource = () => ({
      buffer: null,
      connect() {},
      disconnect() {},
      start() {},
      stop() {},
      onended: null,
    });
    this.resume = () => {
      clock += 500;
      return Promise.resolve();
    };
    this.close = () => Promise.resolve();
  };

  return {
    nodes,
    advance: (ms) => { clock += ms; },
    worklet: () => nodes.find((node) => node.name === "speaker-processor"),
    restore() {
      if (previous === undefined) delete globalThis.performance;
      else globalThis.performance = previous;
      delete globalThis.AudioContext;
      delete globalThis.AudioWorkletNode;
    },
  };
}

test("AudioEngine drops device PCM while the browser stream owns the output", async () => {
  const fake = installFakeAudio();
  try {
    const engine = new AudioEngine();
    assert.equal(await engine.init(), true);
    const worklet = fake.worklet();
    const samples = new Int16Array(9600); // 0.1 s of 48 kHz stereo
    const format = { rate: 48000, channels: 2, bits: 16 };

    assert.equal(engine.play(samples, format), true);
    assert.equal(worklet.port.messages.filter((message) => message.samples).length, 1);
    assert.equal(engine.externalAudio, false);

    assert.equal(engine.setExternalAudio(true), true);
    assert.deepEqual(
      worklet.port.messages.filter((message) => message.type === "live").map((message) => message.on),
      [false],
      "环形缓冲停放，避免把设计中的静音记成欠载",
    );

    engine.setAutoReplay({ enabled: true, target: 1 });
    for (let index = 0; index < 5; index++) {
      assert.equal(engine.play(samples, format), true);
    }
    assert.equal(worklet.port.messages.filter((message) => message.samples).length, 1);
    assert.equal(engine.capture.active, false, "直连期间不再另开缓存");
    assert.equal(engine.replay.active, false);
    assert.equal(engine.levels.external, true);

    // 到达率仍在统计：不解码不代表不计数，性能面板的口径要不断。
    fake.advance(1100);
    engine.play(samples, format);
    const ratio = engine.levels.audioRatio;
    assert.ok(Number.isFinite(ratio) && ratio > 0 && ratio <= 1, `一个窗口后到达率应可算出，实得 ${ratio}`);

    // 交还输出前先关自动缓存，否则这里会先去攒下一段，看不出实时路径已恢复。
    engine.setAutoReplay({ enabled: false });
    assert.equal(engine.setExternalAudio(false), false);
    assert.equal(engine.play(samples, format), true);
    assert.equal(worklet.port.messages.filter((message) => message.samples).length, 2);
    assert.deepEqual(
      worklet.port.messages.filter((message) => message.type === "live").map((message) => message.on),
      [false, true],
    );
    engine.close();
  } finally {
    fake.restore();
  }
});

test("AudioEngine keeps the parked ring parked across flush and re-init", async () => {
  const fake = installFakeAudio();
  try {
    const engine = new AudioEngine();
    await engine.init();
    engine.setExternalAudio(true);
    engine.flush();
    const worklet = fake.worklet();
    assert.deepEqual(
      worklet.port.messages.filter((message) => message.type === "live").map((message) => message.on),
      [false],
      "flush 不该把输出交还实时路径",
    );
    engine.close();

    // 新开的环形缓冲默认是实时的，初始化后要按当前归属再停一次。
    await engine.init();
    assert.equal(engine.externalAudio, true);
    assert.deepEqual(
      fake.worklet().port.messages.filter((message) => message.type === "live").map((message) => message.on),
      [false],
    );
    engine.close();
  } finally {
    fake.restore();
  }
});
