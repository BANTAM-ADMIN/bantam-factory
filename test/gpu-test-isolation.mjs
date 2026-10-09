// Unit tests use synthetic model endpoints. Real GPU qualification is the
// explicit --live script, never an npm test side effect on a developer's rig.
process.env.BANTAM_GPU_HANDOFF = 'off';
