import samples from './sampleFeatures.json';

/**
 * Risk profiles for the transfer form (contracts §0.8). The samples are real dataset rows,
 * categorised by the production models recorded in sampleFeatures.json.
 */
export const RISK_PROFILES = [
  {
    id: 'default',
    label: 'Default',
    hint: 'Sends no feature vector: the server builds a neutral one, so this is normally approved instantly.',
  },
  {
    id: 'normal',
    label: 'Normal sample',
    hint: 'A real, legitimate card transaction. Expected: approved instantly by the quick scan.',
  },
  {
    id: 'suspicious',
    label: 'Suspicious sample',
    hint: 'A real transaction the quick scan flags and the deep scan rates medium or high risk. Expected: a notification or an OTP step-up.',
  },
  {
    id: 'fraud',
    label: 'Known fraud sample',
    hint: 'A real fraudulent transaction. Expected: blocked, account frozen and sent to manual review.',
  },
];

export const SAMPLE_MODELS = samples.models;

/** A random sample of the profile's category, or null for Default. */
export function pickSample(profileId, random = Math.random) {
  const list = samples.categories[profileId];
  if (!list?.length) return null;
  const index = Math.floor(random() * list.length);
  return { profileId, index, count: list.length, features: list[index] };
}

/** The sample's own amount, which the transfer form pre-fills (the server overwrites Amount with it). */
export const sampleAmount = (sample) => (Math.round(sample.features.Amount * 100) / 100).toFixed(2);
