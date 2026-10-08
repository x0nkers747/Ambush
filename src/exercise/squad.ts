import type { MovementParams } from '#sim';
import {
  validateOrganizationTemplate,
  type OrganizationInstance,
  type OrganizationTemplate,
} from './organization';
import usmcRifleSquad from './organizations/usmc-rifle-squad-mcwp-3-11-2.json';

// The trainee's squad as every built-in scenario uses it: the demo and the
// minimal scenario on imported terrain (docs/adr/0012, docs/adr/0014).

/** The default trainee organization: the 13-Marine rifle squad of MCWP 3-11.2. */
export const USMC_RIFLE_SQUAD_TEMPLATE = validateOrganizationTemplate(usmcRifleSquad);

/** Who fills which slot: soldier ids M01, M02, … in slot order (independent of slot ids). */
export function squadInstance(
  template: OrganizationTemplate = USMC_RIFLE_SQUAD_TEMPLATE,
): OrganizationInstance {
  return {
    templateId: template.id,
    templateVersion: template.version,
    side: 'BLUEFOR',
    unitIdPrefix: '',
    facingDeg: 0,
    posture: 'standing',
    members: template.slots.map((slot, i) => ({
      soldierId: `M${String(i + 1).padStart(2, '0')}`,
      slotId: slot.id,
    })),
  };
}

/** Scenario-wide movement (docs/adr/0008). */
export const DEFAULT_MOVEMENT: MovementParams = { speed: 1.5, maxTurnRate: Math.PI / 2 };
