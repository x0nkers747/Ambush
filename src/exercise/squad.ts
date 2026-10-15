import { validateOrganizationTemplate } from './organization';
import usmcRifleSquad from './organizations/usmc-rifle-squad-mcwp-3-11-2.json';

// The USMC rifle squad (docs/adr/0012): the squad organization of battles
// and the labs (src/exercise/forces).

/** The 13-Marine rifle squad of MCWP 3-11.2. */
export const USMC_RIFLE_SQUAD_TEMPLATE = validateOrganizationTemplate(usmcRifleSquad);
