const mapSummaryText = document.querySelector('#mapSummaryText');
const mapEmpty = document.querySelector('#mapEmpty');
const mapFit = document.querySelector('#mapFit');
const mapPreview = document.querySelector('#mapPreview');
const mapPreviewClose = document.querySelector('#mapPreviewClose');
const mapPreviewThumb = document.querySelector('#mapPreviewThumb');
const mapPreviewKicker = document.querySelector('#mapPreviewKicker');
const mapPreviewName = document.querySelector('#mapPreviewName');
const mapPreviewMeta = document.querySelector('#mapPreviewMeta');
const mapPreviewOpen = document.querySelector('#mapPreviewOpen');

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const photoMap = L.map('map', {
  zoomControl: false,
  minZoom: 3,
  // 高德地图在国内的街道瓦片可以到 18 级。
  maxZoom: 18,
  worldCopyJump: true,
});

L.control
  .zoom({
    position: 'topright',
    zoomInTitle: '放大',
    zoomOutTitle: '缩小',
  })
  .addTo(photoMap);

L.tileLayer(
  'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
  {
    subdomains: '1234',
    attribution:
      '&copy; <a href="https://www.amap.com/">高德地图</a>',
    maxNativeZoom: 18,
    maxZoom: 18,
  }
).addTo(photoMap);

photoMap.setView([35.8617, 104.1954], 4);

const markerGroup = L.markerClusterGroup({
  showCoverageOnHover: false,
  zoomToBoundsOnClick: true,
  spiderfyOnMaxZoom: true,
  spiderfyDistanceMultiplier: 1.4,
  maxClusterRadius: 48,
  removeOutsideVisibleBounds: true,
  iconCreateFunction(cluster) {
    return L.divIcon({
      html: `<div class="photo-cluster"><span>${cluster.getChildCount()}</span></div>`,
      className: 'photo-cluster-wrap',
      iconSize: [48, 48],
      iconAnchor: [24, 24],
    });
  },
});

photoMap.addLayer(markerGroup);

let geoItems = [];

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : dateFormatter.format(date);
}

// 高德地图使用 GCJ-02 坐标，照片 EXIF 使用 WGS-84。
// 这里只转换地图上的显示位置，照片详情里的 GPS 坐标仍保持原样。
const GCJ02_A = 6378245.0;
const GCJ02_EE = 0.00669342162296594323;

function isOutsideChina(latitude, longitude) {
  return (
    longitude < 72.004 ||
    longitude > 137.8347 ||
    latitude < 0.8293 ||
    latitude > 55.8271
  );
}

function transformLatitude(x, y) {
  let result =
    -100 +
    2 * x +
    3 * y +
    0.2 * y * y +
    0.1 * x * y +
    0.2 * Math.sqrt(Math.abs(x));

  result +=
    ((20 * Math.sin(6 * x * Math.PI) +
      20 * Math.sin(2 * x * Math.PI)) *
      2) /
    3;
  result +=
    ((20 * Math.sin(y * Math.PI) +
      40 * Math.sin((y / 3) * Math.PI)) *
      2) /
    3;
  result +=
    ((160 * Math.sin((y / 12) * Math.PI) +
      320 * Math.sin((y * Math.PI) / 30)) *
      2) /
    3;

  return result;
}

function transformLongitude(x, y) {
  let result =
    300 +
    x +
    2 * y +
    0.1 * x * x +
    0.1 * x * y +
    0.1 * Math.sqrt(Math.abs(x));

  result +=
    ((20 * Math.sin(6 * x * Math.PI) +
      20 * Math.sin(2 * x * Math.PI)) *
      2) /
    3;
  result +=
    ((20 * Math.sin(x * Math.PI) +
      40 * Math.sin((x / 3) * Math.PI)) *
      2) /
    3;
  result +=
    ((150 * Math.sin((x / 12) * Math.PI) +
      300 * Math.sin((x / 30) * Math.PI)) *
      2) /
    3;

  return result;
}

function wgs84ToGcj02(latitude, longitude) {
  if (isOutsideChina(latitude, longitude)) {
    return [latitude, longitude];
  }

  let latitudeOffset = transformLatitude(longitude - 105, latitude - 35);
  let longitudeOffset = transformLongitude(longitude - 105, latitude - 35);
  const radLatitude = (latitude / 180) * Math.PI;
  let magic = Math.sin(radLatitude);
  magic = 1 - GCJ02_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);

  latitudeOffset =
    (latitudeOffset * 180) /
    (((GCJ02_A * (1 - GCJ02_EE)) / (magic * sqrtMagic)) * Math.PI);
  longitudeOffset =
    (longitudeOffset * 180) /
    ((GCJ02_A / sqrtMagic) * Math.cos(radLatitude) * Math.PI);

  return [latitude + latitudeOffset, longitude + longitudeOffset];
}

function getMapPosition(item) {
  return wgs84ToGcj02(item.latitude, item.longitude);
}

function createMarkerIcon(item) {
  const image = item.thumbUrl
    ? `<img src="${item.thumbUrl}" alt="" loading="lazy">`
    : '';
  const videoBadge =
    item.type === 'video'
      ? '<span class="marker-video-badge" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M8 5.8c0-.9 1-1.45 1.76-.97l8.35 5.2a1.15 1.15 0 0 1 0 1.94l-8.35 5.2A1.15 1.15 0 0 1 8 16.2V5.8Z" fill="currentColor"/></svg></span>'
      : '';

  return L.divIcon({
    html: `<div class="photo-marker">${image}</div>${videoBadge}`,
    className: 'photo-marker-wrap',
    iconSize: [56, 56],
    iconAnchor: [28, 28],
    tooltipAnchor: [0, -34],
  });
}

function fitAllLocations({ animate = true } = {}) {
  if (!geoItems.length) {
    return;
  }

  if (geoItems.length === 1) {
    photoMap.setView(getMapPosition(geoItems[0]), 16, {
      animate,
    });
    return;
  }

  const bounds = L.latLngBounds(
    geoItems.map((item) => getMapPosition(item))
  );

  photoMap.fitBounds(bounds, {
    paddingTopLeft: [50, 90],
    paddingBottomRight: [50, 180],
    maxZoom: 16,
    animate,
  });
}

function closePreview() {
  mapPreview.hidden = true;
}

function selectPhoto(item, marker) {
  mapPreview.hidden = false;
  mapPreviewThumb.src = item.thumbUrl || '';
  mapPreviewThumb.alt = item.name;
  mapPreviewKicker.textContent = `${item.type === 'video' ? '视频' : '照片'} · ${formatDate(item.takenAt)}`;
  mapPreviewName.textContent = item.name;
  mapPreviewMeta.textContent = `GPS ${item.latitude.toFixed(5)}, ${item.longitude.toFixed(5)}`;
  mapPreviewOpen.textContent = item.type === 'video' ? '查看视频' : '查看照片';
  mapPreviewOpen.href = `/?photo=${encodeURIComponent(item.id)}`;

  if (marker) {
    photoMap.panInside(marker.getLatLng(), {
      paddingTopLeft: [40, 90],
      paddingBottomRight: [40, 240],
      animate: true,
    });
  }
}

function addPhotoMarker(item) {
  const marker = L.marker(getMapPosition(item), {
    icon: createMarkerIcon(item),
    title: item.name,
    alt: item.name,
    keyboard: true,
  });

  marker.bindTooltip(item.name, {
    direction: 'top',
    offset: [0, -28],
    className: 'photo-tooltip',
    opacity: 1,
  });

  marker.on('click', (event) => {
    if (event.originalEvent) {
      L.DomEvent.stopPropagation(event.originalEvent);
    }

    selectPhoto(item, marker);
  });

  markerGroup.addLayer(marker);
  return marker;
}

function renderMap(items) {
  geoItems = items.filter(
    (item) =>
      typeof item.latitude === 'number' &&
      typeof item.longitude === 'number'
  );

  if (!geoItems.length) {
    mapSummaryText.textContent = '没有带位置信息的照片';
    mapEmpty.hidden = false;
    mapFit.hidden = true;
    return;
  }

  mapSummaryText.textContent = `${geoItems.length} 个有位置的项目`;
  mapEmpty.hidden = true;
  mapFit.hidden = geoItems.length < 2;

  for (const item of geoItems) {
    addPhotoMarker(item);
  }

  window.setTimeout(() => {
    fitAllLocations({ animate: false });
    photoMap.invalidateSize();
  }, 120);

  const requestedPhotoId = new URLSearchParams(window.location.search).get(
    'photo'
  );
  const requestedItem = geoItems.find((item) => item.id === requestedPhotoId);

  if (requestedItem) {
    window.setTimeout(() => {
      photoMap.setView(getMapPosition(requestedItem), 16, {
        animate: false,
      });
      selectPhoto(requestedItem);
    }, 260);
  }
}

async function loadMap() {
  try {
    const response = await fetch('/api/photos', {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    renderMap(data.items);
  } catch (error) {
    console.error(error);
    mapSummaryText.textContent = '位置信息读取失败，请刷新页面';
  }
}

mapPreviewClose.addEventListener('click', closePreview);
mapFit.addEventListener('click', () => fitAllLocations());
photoMap.on('click', closePreview);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !mapPreview.hidden) {
    closePreview();
  }
});

window.addEventListener('resize', () => {
  photoMap.invalidateSize();
});

window.setTimeout(() => {
  photoMap.invalidateSize();
}, 80);

loadMap();
