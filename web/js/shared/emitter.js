export class Emitter {
  #listeners = new Map();

  on(type, callback) {
    let set = this.#listeners.get(type);
    if (!set) this.#listeners.set(type, (set = new Set()));
    set.add(callback);
    return () => this.off(type, callback);
  }

  off(type, callback) {
    this.#listeners.get(type)?.delete(callback);
  }

  emit(type, ...args) {
    for (const callback of this.#listeners.get(type) ?? []) {
      try {
        callback(...args);
      } catch (error) {
        console.error(error);
      }
    }
  }
}
