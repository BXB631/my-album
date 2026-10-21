const fs = require('node:fs');
const path = require('node:path');

const CITIES = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'cities-cn.json'), 'utf8')
).map((city) => ({
  name: city.name,
  latitude: city.lat,
  longitude: city.lng,
  latitudeRadians: (city.lat * Math.PI) / 180,
}));

const EARTH_RADIUS_KM = 6371;
const MAX_DISTANCE_KM = 250;

function getCity(latitude, longitude) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  const latitudeRadians = (latitude * Math.PI) / 180;
  const longitudeRadians = (longitude * Math.PI) / 180;
  let nearest = null;
  let nearestDistance = Infinity;

  for (const city of CITIES) {
    const deltaLatitude = city.latitudeRadians - latitudeRadians;
    const deltaLongitude = (city.longitude * Math.PI) / 180 - longitudeRadians;
    const a =
      Math.sin(deltaLatitude / 2) ** 2 +
      Math.cos(latitudeRadians) *
        Math.cos(city.latitudeRadians) *
        Math.sin(deltaLongitude / 2) ** 2;
    const distance =
      2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = city;
    }
  }

  if (!nearest || nearestDistance > MAX_DISTANCE_KM) {
    return null;
  }

  return nearest.name;
}

module.exports = { getCity };
