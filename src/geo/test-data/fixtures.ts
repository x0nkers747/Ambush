import type { OverpassResponse } from '../osm';
import grafenwoehr from './grafenwoehr-de.overpass.json';
import quantico from './quantico-va.overpass.json';

// Recorded Overpass responses for tests in any layer (`#geo/fixtures`; see
// README.md here). Only tests import this entry point, so the application
// never bundles the fixtures.

/** 38.5223° N, 77.2934° W: Quantico, Virginia. */
export const QUANTICO_OSM = quantico as OverpassResponse;
export const QUANTICO_CENTRE = { lat: 38.5223, lon: -77.2934 } as const;

/** 49.7170° N, 11.9060° E: Grafenwöhr, Bavaria. */
export const GRAFENWOEHR_OSM = grafenwoehr as OverpassResponse;
export const GRAFENWOEHR_CENTRE = { lat: 49.717, lon: 11.906 } as const;
