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
    /** Shown on the startup overlay while the globe textures download. */
    readonly loadingAssets: string;
    /** Same, once at least one texture has landed — real feedback on slow links. */
    readonly loadingAssetsProgress: (loaded: number, total: number) => string;
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
    /** Shown when filters match nothing in the baked subset. */
    readonly noMatchesInSubset: string;
    /** Shown when the regime filter has no baked data to work with. */
    readonly regimeUnavailable: string;
    /** Count of records shown despite an unclassified object. */
    readonly regimeUnknownShown: (count: number, analyst: number, absent: number) => string;
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
  readonly dataBanner: {
    /** Stale-data notice; `age` is already localized via formatAge. */
    readonly stale: (age: string) => string;
    readonly fetchLatest: string;
    readonly fetching: string;
    readonly dismiss: string;
    readonly fetchFailed: string;
  };
  readonly age: {
    readonly justNow: string;
    readonly hours: (n: number) => string;
    readonly days: (n: number) => string;
  };
  readonly infoPanel: {
    readonly dataEpoch: string;
    readonly dataEpochUnknown: string;
    /** Always-visible scope statement; the app must never imply completeness. */
    readonly scope: (shown: number, perFile: number, total: string) => string;
    readonly scopeUnknownTotal: (shown: number, perFile: number) => string;
    /** Neutral note: our pipeline is fine, CelesTrak just hasn't published. */
    readonly upstreamQuiet: string;
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
    readonly sharedOrbitSolution: string;
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
    /** Upstream publishes one orbit solution for both objects — see sharesOrbitSolution. */
    readonly sharedOrbitSolution: (
      objectId1: string,
      objectId2: string,
      socratesRange: string,
    ) => string;
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
    loadingAssets: 'Loading map imagery…',
    loadingAssetsProgress: (loaded, total) => `Loading map imagery… ${loaded} of ${total}`,
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
    noMatchesInSubset:
      'No conjunctions match these filters in the baked subset. Matching events may ' +
      'exist in the full SOCRATES screening run.',
    regimeUnavailable:
      'Regime filtering needs the pre-built data file and is unavailable on live-fetched data.',
    regimeUnknownShown: (count, analyst, absent) => {
      const base =
        `${count} record${count === 1 ? '' : 's'} include an object with no catalogued ` +
        'regime; they are shown regardless of the regime filter.';
      // A payload baked before the provenance split carries neither count.
      // Say nothing rather than claim "0 analyst, 0 absent".
      if (analyst + absent === 0) {
        return base;
      }
      return (
        `${base} Of those objects, ${analyst} ${analyst === 1 ? 'is' : 'are'} ` +
        `analyst-range (80000-89999, uncorrelated tracks) and ${absent} ` +
        `${absent === 1 ? 'is a' : 'are'} valid catalogue ` +
        `number${absent === 1 ? '' : 's'} not yet in our catalogue snapshot.`
      );
    },
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
  dataBanner: {
    stale: (age) => `Conjunction data is ${age} old`,
    fetchLatest: 'Fetch latest',
    fetching: 'Fetching…',
    dismiss: 'Dismiss',
    fetchFailed: 'Could not fetch the latest data. Showing the previous data.',
  },
  age: {
    justNow: 'less than an hour',
    hours: (n) => `${n} hour${n === 1 ? '' : 's'}`,
    days: (n) => `${n} day${n === 1 ? '' : 's'}`,
  },
  infoPanel: {
    dataEpoch: 'Data epoch',
    dataEpochUnknown: 'unknown',
    scope: (shown, perFile, total) =>
      `Showing the ${perFile} closest approaches and ${perFile} highest-probability ` +
      `events from SOCRATES (${shown} of ~${total} screened conjunctions).`,
    scopeUnknownTotal: (shown, perFile) =>
      `Showing the ${perFile} closest approaches and ${perFile} highest-probability ` +
      `events from SOCRATES (${shown} conjunctions; the full screening run is larger).`,
    upstreamQuiet: 'CelesTrak has not published new SOCRATES data recently.',
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
    sharedOrbitSolution: 'Objects share one orbit solution.',
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
    sharedOrbitSolution: (objectId1, objectId2, socratesRange) =>
      'CelesTrak publishes a single shared orbit solution for these two objects ' +
      `(${objectId1} and ${objectId2} are pieces of the same launch, not yet individually ` +
      'resolved), so SGP4 propagates them to the same point and they cannot be ' +
      `separated here. SOCRATES reports ${socratesRange} using better-resolved orbits. ` +
      'Visualization skipped.',
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
    loadingAssets: 'Cargando imágenes del mapa…',
    loadingAssetsProgress: (loaded, total) => `Cargando imágenes del mapa… ${loaded} de ${total}`,
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
    noMatchesInSubset:
      'Ninguna conjunción coincide con estos filtros en el subconjunto incluido. Pueden ' +
      'existir eventos coincidentes en el análisis completo de SOCRATES.',
    regimeUnavailable:
      'El filtro por régimen orbital requiere el archivo de datos precompilado y no está ' +
      'disponible con datos obtenidos en vivo.',
    regimeUnknownShown: (count, analyst, absent) => {
      const base =
        `${count} registro${count === 1 ? '' : 's'} ${count === 1 ? 'incluye' : 'incluyen'} ` +
        'un objeto sin régimen catalogado; se muestran independientemente del filtro ' +
        'por régimen.';
      // Un archivo generado antes de esta división no trae ninguno de los dos
      // recuentos. Mejor callar que afirmar «0 y 0».
      if (analyst + absent === 0) {
        return base;
      }
      return (
        `${base} De esos objetos, ${analyst} ${analyst === 1 ? 'pertenece' : 'pertenecen'} ` +
        `al rango de analista (80000-89999, trazas no correlacionadas) y ${absent} ` +
        `${absent === 1 ? 'es un número' : 'son números'} de catálogo ` +
        `${absent === 1 ? 'válido' : 'válidos'} que aún no ` +
        `${absent === 1 ? 'figura' : 'figuran'} en nuestra instantánea del catálogo.`
      );
    },
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
  dataBanner: {
    stale: (age) => `Los datos de conjunciones tienen ${age} de antigüedad`,
    fetchLatest: 'Obtener los más recientes',
    fetching: 'Obteniendo…',
    dismiss: 'Descartar',
    fetchFailed: 'No se pudieron obtener los datos más recientes. Se muestran los anteriores.',
  },
  age: {
    justNow: 'menos de una hora',
    hours: (n) => `${n} hora${n === 1 ? '' : 's'}`,
    days: (n) => `${n} día${n === 1 ? '' : 's'}`,
  },
  infoPanel: {
    dataEpoch: 'Época de los datos',
    dataEpochUnknown: 'desconocida',
    scope: (shown, perFile, total) =>
      `Mostrando las ${perFile} aproximaciones máximas más cercanas y los ${perFile} eventos ` +
      `de mayor probabilidad de SOCRATES (${shown} de ~${total} conjunciones analizadas).`,
    scopeUnknownTotal: (shown, perFile) =>
      `Mostrando las ${perFile} aproximaciones máximas más cercanas y los ${perFile} eventos ` +
      `de mayor probabilidad de SOCRATES (${shown} conjunciones; el análisis completo es mayor).`,
    upstreamQuiet: 'CelesTrak no ha publicado datos SOCRATES nuevos recientemente.',
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
    sharedOrbitSolution: 'Los objetos comparten una solución orbital.',
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
    sharedOrbitSolution: (objectId1, objectId2, socratesRange) =>
      'CelesTrak publica una única solución orbital compartida para estos dos objetos ' +
      `(${objectId1} y ${objectId2} son piezas del mismo lanzamiento, aún sin resolver por ` +
      'separado), por lo que SGP4 los propaga al mismo punto y no pueden distinguirse ' +
      `aquí. SOCRATES informa ${socratesRange} usando órbitas mejor resueltas. ` +
      'Se omitió la visualización.',
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
