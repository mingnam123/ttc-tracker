// One entry per transit agency. Every ID that comes out of a feed (vehicle, route, trip, shape)
// is prefixed "<AGENCY>:" so TTC and YRT identifiers can never collide (both agencies use ids like "1" or "52").
//
// Override any URL without editing this file, e.g.:
//   YRT_VEHICLES_URL="https://..." npm start
export const AGENCIES = [
  {
    id: 'TTC',
    vehicles: process.env.TTC_VEHICLES_URL || 'https://bustime.ttc.ca/gtfsrt/vehicles',
    trips: process.env.TTC_TRIPS_URL || 'https://bustime.ttc.ca/gtfsrt/trips',
    // Official TTC GTFS-RT service alerts (gtfsrt.ttc.ca): the same data behind ttc.ca/service-advisories/Service-Changes.
    alerts: process.env.TTC_ALERTS_URL || 'https://gtfsrt.ttc.ca/alerts/all?format=binary',
    staticCkan: 'https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_show?id=7795b45e-e65a-4465-81fc-c36b9dfff169',
  },
  {
    id: 'YRT',
    // Static schedule: direct link listed in the Mobility Database (YRT's own page routes you through a licence form).
    staticZip: process.env.YRT_STATIC_ZIP || 'https://www.yrt.ca/google/google_transit.zip',
    // Real-time: UNVERIFIED defaults. YRT's open-data page does not publish these endpoints.
    // Confirm them (e.g. on transit.land -> feed f-yrt~rt) and override with the env vars below if they differ.
    vehicles: process.env.YRT_VEHICLES_URL || 'https://rtu.york.ca/gtfsrealtime/VehiclePositions',
    trips: process.env.YRT_TRIPS_URL || 'https://rtu.york.ca/gtfsrealtime/TripUpdates',
    alerts: process.env.YRT_ALERTS_URL || null, // optional GTFS-RT alerts feed, if YRT ever publishes one
    // No feed exists, so the HTML page is scraped instead (see yrt-alerts.js). Set YRT_ALERTS_PAGE=off to disable.
    alertsPage: process.env.YRT_ALERTS_PAGE === 'off' ? null : (process.env.YRT_ALERTS_PAGE || 'https://www.yrt.ca/en/schedules-and-maps/service-changes-and-updates.aspx'),
  },
];

// Vehicle type from the feed's vehicle.id (the fleet number painted on the vehicle).
// TTC streetcar fleet numbers (CPTDB / Transit Toronto rosters): CLRV 4000-4005 & 4010-4199, ALRV 4200-4251
// (both retired in 2019), Flexity 4400-4663. No TTC bus uses 4000-4999, so that whole block means "streetcar";
// every other numeric id (and W-prefixed Wheel-Trans / community buses) is a bus.
// Returns 'streetcar' | 'bus' | null. null = "can't tell from the id": the page then falls back to the route's GTFS route_type.
export function vehicleType(agencyId, rawId) {
  const id = String(rawId ?? '').trim();
  if (agencyId === 'TTC') {
    if (/^\d+$/.test(id)) { const n = Number(id); return n >= 4000 && n <= 4999 ? 'streetcar' : 'bus'; }
    if (/^W\d+$/i.test(id)) return 'bus';
    return null;
  }
  if (agencyId === 'YRT') return 'bus'; // York Region Transit runs buses only (ids look like C1421, F0908, M0933, V1373)
  return null;
}

// Fleet roster: [first, last, manufacturer, model, propulsion, length, built].
// Bus rows from Transit Toronto's TTC bus roster (transittoronto.ca/bus/8500.shtml).
// Streetcar rows are from general knowledge, not that page. Ids that fall in a gap return null.
const TTC_FLEET = [
  [1200, 1423, 'Orion', 'VII Next Gen', 'Hybrid', '12 m', '2007-08'],
  [1500, 1689, 'Orion', 'VII Next Gen', 'Hybrid', '12 m', '2008'],
  [3100, 3369, 'Nova Bus', 'LFS', 'Diesel', '12 m', '2018'],
  [3400, 3654, 'Nova Bus', 'LFS', 'Hybrid', '12 m', '2018-19'],
  [3700, 3724, 'New Flyer', 'XE40', 'Electric', '12 m', '2019'],
  [3725, 3749, 'Proterra', 'BE40', 'Electric', '12 m', '2019'],
  [3750, 3759, 'BYD', 'K9M', 'Electric', '12 m', '2019'],
  [4000, 4199, 'Bombardier', 'CLRV', 'Streetcar', '15 m', '1977-81'],
  [4200, 4251, 'Bombardier', 'ALRV', 'Streetcar', '23 m', '1987-89'],
  [4400, 4604, 'Bombardier', 'Flexity Outlook', 'Streetcar', '30 m', '2014-19'],
  [6000, 6203, 'New Flyer', 'XE40 NG', 'Electric', '12 m', '2024'],
  [6600, 6735, 'Nova Bus', 'LFSe+', 'Electric', '12 m', '2024-25'],
  [7000, 7133, 'Nova Bus', 'LFS', 'Hybrid', '12 m', '2023'],
  [7200, 7333, 'New Flyer', 'XDE40', 'Hybrid', '12 m', '2023'],
  [7900, 7901, 'Orion', 'VII', 'Diesel', '12 m', '2006'],
  [8100, 8219, 'Orion', 'VII Next Gen', 'Diesel', '12 m', '2009-10'],
  [8300, 8396, 'Orion', 'VII', 'Diesel', '12 m', '2011-12'],
  [8400, 8504, 'Nova Bus', 'LFS', 'Diesel', '12 m', '2015-16'],
  [8510, 8617, 'Nova Bus', 'LFS', 'Diesel', '12 m', '2016-17'],
  [8620, 8716, 'Nova Bus', 'LFS', 'Diesel', '12 m', '2017'],
  [8720, 8964, 'Nova Bus', 'LFS', 'Diesel', '12 m', '2017'],
  [9000, 9152, 'Nova Bus', 'LFS Artic', 'Diesel', '18 m', '2013-14'],
  [9200, 9239, 'Nova Bus', 'LFS', 'Diesel', '12 m', '2018'],
  [9400, 9467, 'New Flyer', 'XDE60', 'Hybrid', '18 m', '2023'],
];

// YRT fleet (transsee.ca/vehicles?a=yrt). Ranges were condensed from the individual numbers listed there; a few numbers inside a range
// may not exist. [from, to, make, model, fuel, length, years]
const YRT_FLEET = [
  [501, 536, 'Van Hool', 'A330', 'Diesel', '12 m', '2005'], [5101, 5160, 'Van Hool', 'A330', 'Diesel', '12 m', '2005'],
  [571, 585, 'New Flyer', 'D40LF', 'Diesel', '12 m', '2005-10'], [601, 618, 'New Flyer', 'D40LF', 'Diesel', '12 m', '2005-10'],
  [701, 730, 'New Flyer', 'D40LF', 'Diesel', '12 m', '2005-10'], [801, 819, 'New Flyer', 'D40LF', 'Diesel', '12 m', '2005-10'],
  [901, 945, 'New Flyer', 'D40LF', 'Diesel', '12 m', '2005-10'], [1001, 1019, 'New Flyer', 'D40LF', 'Diesel', '12 m', '2005-10'],
  [1020, 1038, 'New Flyer', 'D40LFR', 'Diesel', '12 m', '2010-11'], [1101, 1120, 'New Flyer', 'D40LFR', 'Diesel', '12 m', '2010-11'],
  [1065, 1072, 'ElDorado', 'E-Z Rider II BRT', 'Diesel', '10 m', '2010'], [1160, 1162, 'ElDorado', 'E-Z Rider II BRT', 'Diesel', '10 m', '2010'],
  [1370, 1396, 'Nova Bus', 'LFS Artic', 'Diesel', '18 m', '2013-23'], [1770, 1774, 'Nova Bus', 'LFS Artic', 'Diesel', '18 m', '2013-23'],
  [1971, 1980, 'Nova Bus', 'LFS Artic', 'Diesel', '18 m', '2013-23'], [2270, 2295, 'Nova Bus', 'LFS Artic', 'Diesel', '18 m', '2013-23'],
  [1401, 1434, 'New Flyer', 'XD40', 'Diesel', '12 m', '2014-26'], [1801, 1826, 'New Flyer', 'XD40', 'Diesel', '12 m', '2014-26'],
  [1901, 1908, 'New Flyer', 'XD40', 'Diesel', '12 m', '2014-26'], [2206, 2240, 'New Flyer', 'XD40', 'Diesel', '12 m', '2014-26'],
  [2576, 2582, 'New Flyer', 'XD40', 'Diesel', '12 m', '2014-26'], [2620, 2672, 'New Flyer', 'XD40', 'Diesel', '12 m', '2014-26'],
  [1501, 1518, 'Nova Bus', 'LFS', 'Diesel', '12 m', '2015-16'], [1601, 1621, 'Nova Bus', 'LFS', 'Diesel', '12 m', '2015-16'],
  [1701, 1715, 'Nova Bus', 'LFS', 'Diesel', '12 m', '2015-16'],
  [1911, 1914, 'New Flyer', 'XE40', 'Battery Electric', '12 m', '2019-25'], [2101, 2106, 'New Flyer', 'XE40', 'Battery Electric', '12 m', '2019-25'],
  [2201, 2202, 'New Flyer', 'XE40', 'Battery Electric', '12 m', '2019-25'], [2501, 2575, 'New Flyer', 'XE40', 'Battery Electric', '12 m', '2019-25'],
  [1921, 1922, 'Nova Bus', 'LFSe', 'Battery Electric', '12 m', '2020'],
  [2001, 2028, 'New Flyer', 'XD60', 'Diesel', '18 m', '2020-26'], [2241, 2264, 'New Flyer', 'XD60', 'Diesel', '18 m', '2020-26'],
  [2601, 2619, 'New Flyer', 'XD60', 'Diesel', '18 m', '2020-26'],
];

// Human-readable model for a fleet number, or null when unknown.
export function vehicleModel(agencyId, rawId) {
  if (agencyId === 'YRT') {
    const n = Number(String(rawId ?? '').trim());
    const r = Number.isInteger(n) ? YRT_FLEET.find(([a, b]) => n >= a && n <= b) : null;
    return r ? `${r[2]} ${r[3]} · ${r[4]} · ${r[5]} · ${r[6]}` : null;
  }
  if (agencyId !== 'TTC') return null;
  const id = String(rawId ?? '').trim();
  if (/^W\d+$/i.test(id)) {
    const n = Number(id.slice(1));
    return n >= 700 && n <= 797 ? 'ProMaster Arboc SOI 21 · Gasoline · 6 m · 2021-22 (Wheel-Trans)' : null;
  }
  if (!/^\d+$/.test(id)) return null;
  const n = Number(id);
  const r = TTC_FLEET.find(([a, b]) => n >= a && n <= b);
  return r ? `${r[2]} ${r[3]} · ${r[4]} · ${r[5]} · ${r[6]}` : null;
}

export const pfx = (agency, id) => (id == null || id === '' ? null : `${agency}:${id}`);
