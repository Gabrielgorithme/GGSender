/*
 * GGSender addition (not part of upstream gSender).
 *
 * The lowest feed override that the slider gives. FluidNC does not accept
 * a feed override below 10% (FeedOverride::Min = 10 in its Config.h; it is
 * set when the firmware is compiled, not in config.yaml). Upstream gSender
 * stops the slider at 20%.
 */
export const FEED_OVERRIDE_MIN_KEY = 'workspace.gg.feedOverrideMin';
export const FEED_OVERRIDE_MIN_OPTIONS = ['10', '20'];

export const feedOverrideMin = (value: unknown): number => (String(value) === '20' ? 20 : 10);
