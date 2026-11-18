# Sourced by the gesture rebuild runner. Maintainers only: this needs Blender 5.x (https://www.blender.org/download/)
# and the Mixamo FBX files (they are NOT in the repository). See docs/GESTURES_PLAN.md.
# Override any of these in your shell before sourcing:
#   BLENDER_EXE   full path to blender.exe
#   ROTO_TOOLS_DIR  scratch/tool folder (default: ~/ROTO_tools); keeps temp files off a full system drive
export ROTO_TOOLS_DIR="${ROTO_TOOLS_DIR:-$HOME/ROTO_tools}"
export BLENDER_EXE="${BLENDER_EXE:-$ROTO_TOOLS_DIR/blender/blender.exe}"
export SCRATCH="${SCRATCH:-$ROTO_TOOLS_DIR/scratch_anim}"
export BLENDER_USER_CONFIG="$SCRATCH/blender_home/config"
export BLENDER_USER_SCRIPTS="$SCRATCH/blender_home/scripts"
export BLENDER_USER_DATAFILES="$SCRATCH/blender_home/data"
export TEMP="$SCRATCH/tmp"
export TMP="$SCRATCH/tmp"
export TMPDIR="$SCRATCH/tmp"
mkdir -p "$SCRATCH/blender_home/config" "$SCRATCH/blender_home/scripts" "$SCRATCH/blender_home/data" "$SCRATCH/tmp"
