import type { FofForceSpec, FofRunSpec } from './run';

// Specs for the force-on-force tests and experiments.

export const SQUAD: Omit<FofForceSpec, 'start' | 'destination'> = {
  organization: 'squad',
  formation: 'usmc.squad.wedge',
  pace: 1.4,
  interval: 10,
  elementSpacing: 20,
};

/** Two squads 1.4 km apart walking at each other (40 m offset), on `terrain`. */
export function headOn(
  terrain: FofRunSpec['terrain'] = 'open',
  seed = 1,
  tickRateHz = 30,
): FofRunSpec {
  return {
    blufor: { ...SQUAD, start: { x: 0, y: -700 }, destination: { x: 0, y: 700 } },
    opfor: { ...SQUAD, start: { x: 40, y: 700 }, destination: { x: 40, y: -700 } },
    terrain,
    seed,
    tickRateHz,
  };
}
