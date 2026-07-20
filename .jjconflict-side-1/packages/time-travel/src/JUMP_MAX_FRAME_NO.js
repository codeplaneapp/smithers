// Upper bound for jump targets: i32 max (2^31 - 1), the widest frame_no the
// frames table can address (validateJumpFrameNo rejects anything above it).
export const JUMP_MAX_FRAME_NO = 2_147_483_647;
