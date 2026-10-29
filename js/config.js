/* Doodle Dash settings. */
window.DD_CONFIG = {
  // Prefix for room ids on the free PeerJS server. Keep it unusual so no other app collides with us.
  peerPrefix: 'doodledash-v1-',
  peerOptions: {
    debug: 0,
    config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
  },
  maxPlayers: 12,
  maxNameLength: 14,
  chooseSeconds: 15,     // drawer picks a word
  roundSeconds: 2.5,     // "Round 2 of 2" banner
  turnEndSeconds: 6,     // "The word was ..." screen
  defaults: { rounds: 2, drawTime: 80, hints: true }
};
// Automated tests: point at a local copy of the PeerJS server and shorten the pauses.
if (window.DD_TEST_PEER) Object.assign(window.DD_CONFIG.peerOptions, window.DD_TEST_PEER);
if (window.DD_TEST_FAST) Object.assign(window.DD_CONFIG, { chooseSeconds: 6, roundSeconds: 0.6, turnEndSeconds: 1.5 });
