import type { OrganizationTemplate, TraineeOrganization } from './organization';
import type { ObjectiveRallyPoint } from './orp';

// Test fixtures: a synthetic organization for the exercise tests' hand-built
// scenarios. Represents no real organization.

/** A two-person team: one unit, a leader slot and a member slot. */
export const TEST_PAIR_TEMPLATE: OrganizationTemplate = {
  schema: 'ambush.organization-template',
  schemaVersion: 1,
  id: 'test-pair',
  version: '1.0.0',
  name: 'Test pair',
  source: { kind: 'synthetic', title: 'Test pair', notes: 'Exercise test fixture.' },
  conventions: [],
  roles: [
    {
      id: 'leader',
      name: 'Leader',
      abbreviation: 'L',
      symbology: { sidc: '10032700001101010000' },
    },
    {
      id: 'member',
      name: 'Member',
      abbreviation: 'M',
      symbology: { sidc: '10032700001101010000' },
    },
  ],
  units: [
    {
      id: 'TM',
      name: 'Team',
      abbreviation: 'TM',
      echelon: 'team',
      parentId: null,
      leaderSlotId: 'lead',
    },
  ],
  slots: [
    { id: 'lead', unitId: 'TM', roleId: 'leader', label: 'L' },
    { id: 'second', unitId: 'TM', roleId: 'member', label: 'M' },
  ],
};

/** Soldiers A (leader) and B of `TEST_PAIR_TEMPLATE`, in unit "TM". */
export const TEST_PAIR_ORGANIZATION: TraineeOrganization = {
  template: TEST_PAIR_TEMPLATE,
  unitIdPrefix: '',
  members: [
    { soldierId: 'A', slotId: 'lead' },
    { soldierId: 'B', slotId: 'second' },
  ],
};

/** An ORP round (5, 0), radius 12 m: holds soldiers at (0, 0) and (10, 0). */
export const TEST_ORP: ObjectiveRallyPoint = {
  id: 'ORP-T',
  name: 'ORP',
  centre: { east: 5, north: 0 },
  shape: { kind: 'circle', radiusM: 12 },
};
