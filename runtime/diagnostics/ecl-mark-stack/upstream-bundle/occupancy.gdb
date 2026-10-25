# Prints mark stack occupancy each time ECL's stacks_scanner starts, then the
# backtrace at the abort. Uses the bundled collector's debug information.
#   gdb -q -batch -x occupancy.gdb --args ecl --norc --load deep.fas --eval '(deep N)'
# N: an aborting depth from sweep.sh (run under gdb, the depth may shift a little).
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
