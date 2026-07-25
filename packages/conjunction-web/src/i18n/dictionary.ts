/**
 * Type-safe i18n dictionary for conjunction-web.
 *
 * The `Dictionary` interface is the single source of truth for every
 * user-facing string. Each language object is typed as `Dictionary`, and
 * `translations` is a `Record<LanguageCode, Dictionary>`, so:
 *   - a language object missing any key fails to compile, and
 *   - adding a third code to `LanguageCode` forces a complete new `Dictionary`
 *     (the compiler demands 100% of the keys) before the build passes.
 *
 * Interpolated strings are typed as functions so their parameters are checked
 * too. Aerospace terminology follows a fixed glossary — see the Spanish (`es`)
 * object; do not machine-translate those terms.
 */
export type LanguageCode = 'en' | 'es';

/** Languages offered in the UI selector, in display order. */
export const LANGUAGES: readonly LanguageCode[] = ['en', 'es'];

export interface Dictionary {
  readonly app: {
    /** GRAZE backronym — kept in English in both locales (it spells the name). */
    readonly subtitle: string;
    readonly disclaimer: string;
    readonly aboutTip: string;
    readonly loading: string;
  };
  readonly language: {
    readonly label: string;
    readonly english: string;
    readonly spanish: string;
  };
  readonly filters: {
    readonly regime: string;
    readonly type: string;
    readonly missMax: string;
    readonly pc: string;
    readonly payload: string;
    readonly debris: string;
    readonly rocketBody: string;
    readonly showAll: string;
    readonly shown: (visible: number, total: number) => string;
  };
  readonly tooltips: {
    readonly regime: string;
    readonly type: string;
    readonly miss: string;
    readonly pc: string;
    readonly tca: string;
    readonly aboutRegime: string;
    readonly aboutType: string;
    readonly aboutMiss: string;
    readonly aboutPc: string;
    readonly aboutGraze: string;
  };
  readonly table: {
    readonly object1: string;
    readonly object2: string;
    readonly tca: string;
    readonly miss: string;
    readonly maxPc: string;
  };
  readonly hud: {
    readonly utc: string;
    readonly range: string;
    readonly tca: string;
    readonly playPause: string;
    readonly playbackSpeed: string;
  };
  readonly infoPanel: {
    readonly placeholder: string;
    readonly tca: string;
    readonly missDistance: string;
    readonly relativeSpeed: string;
    readonly maxProbability: string;
    readonly object1: string;
    readonly object2: string;
    readonly inclination: string;
    readonly apogee: string;
    readonly perigee: string;
    readonly period: string;
    readonly missWithSocrates: (actual: string, socrates: string) => string;
    readonly fetchingGp: (id1: number, id2: number) => string;
    readonly propagating: string;
  };
  readonly status: {
    readonly analyzing: (name1: string, name2: string) => string;
    readonly showing: (name1: string, name2: string) => string;
    readonly gpUnavailable: string;
    readonly propagationFailed: string;
    readonly fetchingSocrates: string;
    readonly loadingLocal: string;
    readonly couldNotLoad: string;
    readonly couldNotLoadLocal: string;
    readonly topConjunctions: (count: number) => string;
    readonly localConjunctions: (count: number, withGp: boolean) => string;
    readonly dataAsOf: (time: string) => string;
    readonly dataAsOfLocal: string;
  };
  readonly errors: {
    readonly couldNotFetchElements: (detail: string) => string;
    readonly propagationFailedDetail: (detail: string) => string;
    readonly couldNotReachSocrates: (detail: string) => string;
    readonly couldNotLoadLocalData: (detail: string) => string;
    readonly noBundledGp: (noradId: number) => string;
    readonly corsHelp: string;
  };
  readonly buttons: {
    readonly retry: string;
    readonly useLocalData: string;
    readonly retryLiveData: string;
    readonly retryLocalData: string;
  };
}

const en: Dictionary = {
  app: {
    subtitle: 'General Rendezvous Assessment and Zone Evaluator',
    disclaimer:
      '⚠ GRAZE uses publicly available GP/TLE data with SGP4 propagation. ' +
      'For educational and awareness purposes only — not for operational conjunction assessment.',
    aboutTip:
      'GRAZE (General Rendezvous Assessment and Zone Evaluator) — a 3D visualizer for upcoming ' +
      'satellite conjunctions from CelesTrak SOCRATES data. This is an early beta; see the ' +
      'disclaimer above. Source, issues, and license are on GitHub (linked in the footer).',
    loading: 'Loading…',
  },
  language: {
    label: 'Language',
    english: 'English',
    spanish: 'Español',
  },
  filters: {
    regime: 'Regime',
    type: 'Type',
    missMax: 'Miss ≤',
    pc: 'Pc',
    payload: 'Payload',
    debris: 'Debris',
    rocketBody: 'R/B',
    showAll: 'show all',
    shown: (visible, total) => `${visible} / ${total} shown`,
  },
  tooltips: {
    regime:
      'Orbit regime — LEO (Low Earth Orbit, <2,000 km altitude), MEO (Medium Earth Orbit), ' +
      'GEO (Geostationary Orbit, ~35,786 km), HEO (Highly Elliptical Orbit).',
    type:
      'Object type — Payload (active or inactive satellite), Debris (fragmentation or ' +
      'mission-related debris), R/B (spent rocket body).',
    miss:
      'Miss distance — predicted closest separation between the two objects at TCA ' +
      '(time of closest approach), in kilometers.',
    pc:
      'Probability of collision (Pc) — estimated chance the two objects collide, based on ' +
      'position uncertainty. Higher = greater risk.',
    tca:
      'Time of Closest Approach (TCA) — predicted UTC date/time when the two objects are ' +
      'nearest each other.',
    aboutRegime: 'About Regime',
    aboutType: 'About Type',
    aboutMiss: 'About miss distance',
    aboutPc: 'About probability of collision',
    aboutGraze: 'About GRAZE',
  },
  table: {
    object1: 'Object 1',
    object2: 'Object 2',
    tca: 'TCA (UTC)',
    miss: 'Miss',
    maxPc: 'Max Pc',
  },
  hud: {
    utc: 'UTC',
    range: 'RANGE',
    tca: 'TCA',
    playPause: 'Play/Pause',
    playbackSpeed: 'Playback speed',
  },
  infoPanel: {
    placeholder: 'Select a conjunction to analyze it.',
    tca: 'TCA',
    missDistance: 'Miss distance',
    relativeSpeed: 'Relative speed',
    maxProbability: 'Max probability',
    object1: 'Object 1',
    object2: 'Object 2',
    inclination: 'Inclination',
    apogee: 'Apogee',
    perigee: 'Perigee',
    period: 'Period',
    missWithSocrates: (actual, socrates) => `${actual} (SOCRATES ${socrates})`,
    fetchingGp: (id1, id2) => `Fetching GP data for ${id1} and ${id2}…`,
    propagating: 'Propagating ±30 min around TCA…',
  },
  status: {
    analyzing: (name1, name2) => `Analyzing ${name1} × ${name2}…`,
    showing: (name1, name2) => `Showing ${name1} × ${name2}`,
    gpUnavailable: 'GP data unavailable.',
    propagationFailed: 'Propagation failed.',
    fetchingSocrates: 'Fetching SOCRATES conjunction data…',
    loadingLocal: 'Loading bundled test data…',
    couldNotLoad: 'Could not load conjunction data.',
    couldNotLoadLocal: 'Could not load local test data.',
    topConjunctions: (count) =>
      `Top ${count} conjunctions by miss distance. Click one to visualize.`,
    localConjunctions: (count, withGp) =>
      `${count} conjunctions from local test data` +
      `${withGp ? ' (orbits from bundled GP files)' : ''}. Click one to visualize.`,
    dataAsOf: (time) => `Data as of: ${time}`,
    dataAsOfLocal: 'Data as of: bundled test snapshot (not live)',
  },
  errors: {
    couldNotFetchElements: (detail) =>
      `Could not fetch orbital elements for this conjunction: ${detail}`,
    propagationFailedDetail: (detail) =>
      `⚠ Propagation failed for this conjunction (element set may be stale or the ` +
      `object decayed): ${detail} Visualization skipped.`,
    couldNotReachSocrates: (detail) => `Could not reach CelesTrak SOCRATES: ${detail}`,
    couldNotLoadLocalData: (detail) => `Could not load the bundled test data: ${detail}`,
    noBundledGp: (noradId) =>
      `No bundled GP data for NORAD ${noradId}. This object is in the test snapshot ` +
      'but has no test-data/gp file — run "npm run refresh:test-data", or use live data ' +
      'with VITE_USE_LIVE=true.',
    corsHelp:
      'If this keeps happening, the browser is likely blocked by CORS or a network ' +
      'failure when calling CelesTrak directly. Deploy the bundled Cloudflare Worker ' +
      'proxy (cf-worker/) and rebuild with VITE_CELESTRAK_BASE set to its URL — see README.md.',
  },
  buttons: {
    retry: 'Retry',
    useLocalData: 'Use local test data',
    retryLiveData: 'Retry live data',
    retryLocalData: 'Retry local test data',
  },
};

const es: Dictionary = {
  app: {
    // Kept in English: it is the backronym that spells "GRAZE".
    subtitle: 'General Rendezvous Assessment and Zone Evaluator',
    disclaimer:
      '⚠ GRAZE usa datos GP/TLE de acceso público con propagación SGP4. ' +
      'Solo para fines educativos y de concientización — no para evaluación operacional de conjunciones.',
    aboutTip:
      'GRAZE (General Rendezvous Assessment and Zone Evaluator) — un visualizador 3D de próximas ' +
      'conjunciones de satélites a partir de datos SOCRATES de CelesTrak. Es una beta temprana; ' +
      'consulta el aviso de arriba. El código fuente, rastreador de incidencias y licencia están en GitHub ' +
      '(enlazado en el pie de página).',
    loading: 'Cargando…',
  },
  language: {
    label: 'Idioma',
    english: 'English',
    spanish: 'Español',
  },
  filters: {
    regime: 'Régimen',
    type: 'Tipo',
    missMax: 'Cruce ≤',
    pc: 'Pc',
    payload: 'Carga útil',
    debris: 'Escombro',
    rocketBody: 'Cohete',
    showAll: 'mostrar todo',
    shown: (visible, total) => `${visible} / ${total} mostradas`,
  },
  tooltips: {
    regime:
      'Régimen orbital — LEO (órbita terrestre baja, altitud <2.000 km), MEO (órbita terrestre ' +
      'media), GEO (órbita geoestacionaria, ~35.786 km), HEO (órbita muy elíptica).',
    type:
      'Tipo de objeto — Carga útil (satélite activo o inactivo), Escombro espacial (escombros de ' +
      'fragmentación o de misión), Etapa de cohete (etapa de cohete agotada).',
    miss:
      'Distancia de cruce — separación mínima prevista entre los dos objetos en el TCA ' +
      '(Tiempo de Máxima Aproximación), en kilómetros.',
    pc:
      'Probabilidad de colisión (Pc) — probabilidad estimada de que los dos objetos colisionen, ' +
      'según la incertidumbre de posición. Mayor = mayor riesgo.',
    tca:
      'Tiempo de Máxima Aproximación (TCA) — fecha/hora UTC prevista en la que los dos objetos ' +
      'están más próximos entre sí.',
    aboutRegime: 'Acerca del régimen orbital',
    aboutType: 'Acerca del tipo de objeto',
    aboutMiss: 'Acerca de la distancia de cruce',
    aboutPc: 'Acerca de la probabilidad de colisión',
    aboutGraze: 'Acerca de GRAZE',
  },
  table: {
    object1: 'Objeto 1',
    object2: 'Objeto 2',
    tca: 'TCA (UTC)',
    miss: 'Cruce',
    maxPc: 'Pc máx.',
  },
  hud: {
    utc: 'UTC',
    range: 'DIST',
    tca: 'TCA',
    playPause: 'Reproducir/Pausar',
    playbackSpeed: 'Velocidad de reproducción',
  },
  infoPanel: {
    placeholder: 'Selecciona una conjunción para analizarla.',
    tca: 'TCA',
    missDistance: 'Distancia de cruce',
    relativeSpeed: 'Velocidad relativa',
    maxProbability: 'Probabilidad máx.',
    object1: 'Objeto 1',
    object2: 'Objeto 2',
    inclination: 'Inclinación',
    apogee: 'Apogeo',
    perigee: 'Perigeo',
    period: 'Período',
    missWithSocrates: (actual, socrates) => `${actual} (SOCRATES ${socrates})`,
    fetchingGp: (id1, id2) => `Obteniendo datos GP de ${id1} y ${id2}…`,
    propagating: 'Propagando ±30 min alrededor del TCA…',
  },
  status: {
    analyzing: (name1, name2) => `Analizando ${name1} × ${name2}…`,
    showing: (name1, name2) => `Mostrando ${name1} × ${name2}`,
    gpUnavailable: 'Datos GP no disponibles.',
    propagationFailed: 'Falló la propagación.',
    fetchingSocrates: 'Obteniendo datos de conjunciones de SOCRATES…',
    loadingLocal: 'Cargando datos de prueba incluidos…',
    couldNotLoad: 'No se pudieron cargar los datos de conjunciones.',
    couldNotLoadLocal: 'No se pudieron cargar los datos de prueba locales.',
    topConjunctions: (count) =>
      `Las ${count} conjunciones con menor distancia de cruce. Haz clic en una para visualizarla.`,
    localConjunctions: (count, withGp) =>
      `${count} conjunciones de datos de prueba locales` +
      `${withGp ? ' (órbitas de archivos GP incluidos)' : ''}. Haz clic en una para visualizarla.`,
    dataAsOf: (time) => `Datos actualizados: ${time}`,
    dataAsOfLocal: 'Datos: instantánea de prueba incluida (no en vivo)',
  },
  errors: {
    couldNotFetchElements: (detail) =>
      `No se pudieron obtener los elementos orbitales de esta conjunción: ${detail}`,
    propagationFailedDetail: (detail) =>
      `⚠ Falló la propagación de esta conjunción (el conjunto de elementos puede estar obsoleto o ` +
      `el objeto reentró): ${detail} Se omitió la visualización.`,
    couldNotReachSocrates: (detail) => `No se pudo conectar con CelesTrak SOCRATES: ${detail}`,
    couldNotLoadLocalData: (detail) => `No se pudieron cargar los datos de prueba incluidos: ${detail}`,
    noBundledGp: (noradId) =>
      `No hay datos GP incluidos para el NORAD ${noradId}. Este objeto está en la instantánea de ` +
      'prueba pero no tiene archivo test-data/gp — ejecuta "npm run refresh:test-data", o usa ' +
      'datos en vivo con VITE_USE_LIVE=true.',
    corsHelp:
      'Si esto sigue ocurriendo, es probable que el navegador esté bloqueado por CORS o por un ' +
      'fallo de red al llamar a CelesTrak directamente. Despliega el Cloudflare Worker incluido ' +
      '(cf-worker/) y recompila con VITE_CELESTRAK_BASE apuntando a su URL — consulta README.md.',
  },
  buttons: {
    retry: 'Reintentar',
    useLocalData: 'Usar datos de prueba locales',
    retryLiveData: 'Reintentar datos en vivo',
    retryLocalData: 'Reintentar datos locales',
  },
};

/**
 * All translations, keyed by language code. Typing this as
 * `Record<LanguageCode, Dictionary>` is what forces a future third language to
 * implement every key before the project compiles.
 */
export const translations: Record<LanguageCode, Dictionary> = { en, es };
