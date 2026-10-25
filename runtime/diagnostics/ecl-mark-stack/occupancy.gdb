# SPDX-License-Identifier: AGPL-3.0-or-later
# Prints mark-stack occupancy whenever ECL's root callback starts. Needs a
# collector built with debug information (the bundled one is, by default).
# gdb -q -batch -x occupancy.gdb --args ecl --norc --load deep.fas --eval '(deep 4016)'
handle SIGSEGV nostop noprint pass
set breakpoint pending on
break stacks_scanner
commands
silent
printf "stacks_scanner entry: used=%d size=%d free=%d\n", (int)(GC_arrays._mark_stack_top - GC_arrays._mark_stack) + 1, (int)GC_arrays._mark_stack_size, (int)(GC_arrays._mark_stack_limit - GC_arrays._mark_stack_top) - 1
continue
end
run
bt 12
