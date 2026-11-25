/** ESP-IDF nvs_open() uses the partition named nvs, not the first NVS subtype. */
export function findNetworkPartition(partitions) {
  return partitions.find((entry) => entry.type === 1 && entry.subtype === 2 && entry.label === "nvs") ?? null;
}
