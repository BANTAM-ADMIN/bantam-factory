export function normalizeCoordinates(value) {
  return { latitude: Number(value.latitude), longitude: Number(value.longitude) };
}
