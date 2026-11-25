// 浏览器直接向电台取流播放。设备侧的 I2S 声音受模拟器算力上限约束，只能到
// 0.2–0.35 倍实时，连续收听必须由网页自己缓冲音频流，这里就是那条路径。
// 地址不写死在面板里：固件开流时会在串口打 `net: connected, streaming: <url>`，
// 网页跟着这一路地址取流，设备切台就跟着切。
import { readJson, writeJson } from "../shared/storage.js";

const STATION_CACHE_KEY = "audioDirectStation";
// ESP-IDF 的日志行以 CR/LF 结尾，也可能被拆进多个报文，解析前由调用方拼好整行。
// 带 g 是为了在拼接出来的尾巴里取最后一条匹配：设备刚切台时，旧地址还在缓冲区里。
const STREAM_URL_RE = /(?:streaming|stream url)\s*[:=]\s*["']?(https?:\/\/[^\s"']+)/gi;
const REDIRECT_URL_RE = /http 3\d{2} -> ["']?(https?:\/\/[^\s"']+)/gi;

/**
 * 从设备串口文本里取出正在播的流地址。只认电台播放器那两行：开流成功后的
 * `streaming: <url>` 与跟随 302 时的 `http 302 -> <url>`。不认 `GET https://…`，
 * 那是取电台列表，不是音频流。多行时取最后一条，也就是设备当前在播的那一路。
 * @param {string} text
 * @returns {string} 取不到时为空串
 */
export function parseStreamUrl(text) {
  const value = String(text ?? "");
  for (const pattern of [STREAM_URL_RE, REDIRECT_URL_RE]) {
    pattern.lastIndex = 0;
    let last = "";
    for (const match of value.matchAll(pattern)) last = match[1];
    if (last) return last;
  }
  return "";
}

/**
 * 浏览器能不能直接播这一路。HLS/DASH/播放列表要另做解封装，明确拒绝，免得跟着
 * 设备切到一个播不出声音的地址。
 * @param {string} url
 * @returns {boolean}
 */
export function isDirectPlayable(url) {
  const value = String(url ?? "").trim();
  if (!/^https?:\/\//i.test(value)) return false;
  if (/\.(m3u8|mpd|pls)(\?|$)/i.test(value)) return false;
  return true;
}

/** 面板上的可读名：主机名 + 路径末段，不去编电台名。 */
export function stationLabel(url) {
  const value = String(url ?? "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value);
    const tail = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() ?? "");
    return tail ? `${parsed.hostname} / ${tail}` : parsed.hostname;
  } catch {
    return value;
  }
}

function mediaError(error) {
  switch (Number(error?.code) || 0) {
    case 1:
      return "播放被中止";
    case 2:
      return "取流失败：网络不通，或站点拒绝了浏览器的直接访问";
    case 3:
      return "解码失败：该流的编码浏览器不支持";
    case 4:
      return "不支持的流格式（HLS/DASH 请改用 MP3/AAC 源）";
    default:
      return "无法播放该地址";
  }
}

/**
 * 用一个 `<audio>` 元素取流：浏览器负责 TCP/TLS、解封装、解码和抖动缓冲，
 * 因此拿到的是和网络电台一样连续的声音，而不是模拟器算出来的碎片。
 */
export class DirectStreamPlayer {
  #createElement;
  #element = null;
  #station = null;
  #error = "";
  #playing = false;
  #buffering = false;
  #volume = 1;
  #muted = false;
  #listeners = new Set();
  #now;
  #since = Number.NaN;
  #gaps = 0;
  #gapPending = false;

  constructor({ createElement, now } = {}) {
    this.#createElement = createElement ?? (() => document.createElement("audio"));
    this.#now = now ?? (() => globalThis.performance?.now?.() ?? Date.now());
  }

  get active() {
    return Boolean(this.#station);
  }

  get station() {
    return this.#station ? { ...this.#station } : null;
  }

  /** @returns {{active:boolean, playing:boolean, buffering:boolean, name:string, url:string, buffered:number, continuous:number, gaps:number, position:number, volume:number, muted:boolean, error:string}} */
  get state() {
    const element = this.#element;
    return {
      active: this.active,
      playing: this.#playing,
      buffering: this.#buffering,
      name: this.#station?.name ?? "",
      url: this.#station?.url ?? "",
      buffered: bufferedSeconds(element),
      // 直播流的 buffered 是两三秒的滚动窗口，不会随时间增长；「已经连续播了多久、
      // 被打断过几次」才是用户判断卡不卡要看的数。
      continuous: this.#playing && Number.isFinite(this.#since)
        ? Math.max(0, (this.#now() - this.#since) / 1000)
        : 0,
      gaps: this.#gaps,
      position: Number.isFinite(element?.currentTime) ? element.currentTime : 0,
      volume: this.#muted ? 0 : this.#volume,
      muted: this.#muted,
      error: this.#error,
    };
  }

  /**
   * @param {(state:object)=>void} listener
   * @returns {()=>void} 取消订阅
   */
  onChange(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit() {
    const state = this.state;
    for (const listener of [...this.#listeners]) listener(state);
  }

  #ensure() {
    if (this.#element) return this.#element;
    const element = this.#createElement();
    if (!element) throw new Error("当前环境无法创建音频元素");
    element.preload = "auto";
    element.volume = this.#muted ? 0 : this.#volume;
    element.addEventListener("playing", () => {
      this.#playing = true;
      this.#buffering = false;
      this.#error = "";
      // 断流后重新开播才算一次打断；首次开播不计。
      if (this.#gapPending) {
        this.#gaps += 1;
        this.#gapPending = false;
        this.#since = this.#now();
      } else if (!Number.isFinite(this.#since)) {
        this.#since = this.#now();
      }
      this.#emit();
    });
    element.addEventListener("waiting", () => {
      this.#buffering = true;
      if (this.#playing) this.#gapPending = true;
      this.#emit();
    });
    element.addEventListener("canplay", () => {
      this.#buffering = false;
      this.#emit();
    });
    element.addEventListener("stalled", () => {
      this.#buffering = true;
      if (this.#playing) this.#gapPending = true;
      this.#emit();
    });
    element.addEventListener("pause", () => {
      this.#playing = false;
      this.#emit();
    });
    element.addEventListener("error", () => {
      // 已经停止的流再报错误，是浏览器迟到的通知，不该把面板重新涂成失败。
      if (!this.#station) return;
      this.#playing = false;
      this.#buffering = false;
      this.#error = mediaError(element.error);
      this.#emit();
    });
    this.#element = element;
    return element;
  }

  /**
   * @param {{name?: string, url: string}} station
   * @returns {Promise<boolean>} 是否已开始播放
   */
  async play(station) {
    const url = String(station?.url || "").trim();
    if (!/^https?:\/\//i.test(url)) {
      this.#error = "地址需以 http(s):// 开头";
      this.#emit();
      return false;
    }
    if (!isDirectPlayable(url)) {
      this.#error = "这路地址是 HLS/DASH，浏览器不能直接播";
      this.#emit();
      return false;
    }
    const element = this.#ensure();
    // 换台才需要先清场：首路流没有旧源可释放，多一次 load 只会让浏览器重新解码。
    if (this.#station) this.stop();
    this.#station = {
      name: String(station?.name || "").trim() || stationLabel(url),
      url,
    };
    this.#buffering = true;
    this.#since = Number.NaN;
    this.#gaps = 0;
    this.#gapPending = false;
    this.#emit();
    element.src = url;
    element.volume = this.#muted ? 0 : this.#volume;
    writeJson(STATION_CACHE_KEY, this.#station);
    try {
      await element.play();
      // 切台会让浏览器中断上一路的 play()，那是让位不是失败：状态已交给新一路。
      if (this.#station?.url !== url) return false;
      if (this.#error) throw new Error(this.#error);
      this.#playing = true;
      this.#buffering = false;
      if (!Number.isFinite(this.#since)) this.#since = this.#now();
      this.#emit();
      return true;
    } catch (error) {
      if (this.#station?.url !== url) return false;
      // play() 的 reject 不带细节，真正的失败原因来自 error 事件或名字。
      if (!this.#error) {
        this.#error = error?.name === "NotAllowedError"
          ? "浏览器阻止了自动播放，请再点一次播放按钮"
          : mediaError(error);
      }
      this.#playing = false;
      this.#buffering = false;
      this.#emit();
      return false;
    }
  }

  /**
   * @param {{keepStation?: boolean}} [options] keepStation 为真时只暂停，面板仍可继续
   */
  stop(options = {}) {
    const element = this.#element;
    if (element) {
      try {
        element.pause();
      } catch {
        // 已销毁或未挂载，无需处理。
      }
      element.removeAttribute("src");
      element.load?.();
    }
    this.#playing = false;
    this.#buffering = false;
    this.#since = Number.NaN;
    this.#gapPending = false;
    if (!options.keepStation) {
      this.#station = null;
      this.#error = "";
      this.#gaps = 0;
    }
    this.#emit();
  }

  resume() {
    const element = this.#element;
    if (!this.#station || !element) return false;
    this.#buffering = true;
    this.#emit();
    element.play?.()?.catch?.(() => {});
    return true;
  }

  setVolume(value) {
    this.#volume = Math.min(1, Math.max(0, Number(value) || 0));
    if (this.#element) this.#element.volume = this.#muted ? 0 : this.#volume;
  }

  setMuted(value) {
    this.#muted = Boolean(value);
    if (this.#element) this.#element.volume = this.#muted ? 0 : this.#volume;
  }

  get lastStation() {
    return readJson(STATION_CACHE_KEY, null);
  }
}

/**
 * 已经缓冲但还没播出去的秒数，只用来判断「还在不在取流」。
 * @param {HTMLAudioElement|null} element
 * @returns {number}
 */
export function bufferedSeconds(element) {
  try {
    const ranges = element?.buffered;
    const length = Number(ranges?.length) || 0;
    if (!length) return 0;
    const end = Number(ranges.end(length - 1));
    const start = Math.max(Number(ranges.start(length - 1)), Number(element.currentTime) || 0);
    return Math.max(0, end - start);
  } catch {
    // 直播流的区间对象随时可能被浏览器换成空集合，读不到就当没缓冲。
    return 0;
  }
}
