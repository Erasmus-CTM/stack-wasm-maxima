(module
  (memory 1)
  (global $__stack_pointer (mut i32) (i32.const 65536))
  (func $make (result i32) (i32.const 1024))
  (func $collect (result i32) (i32.const 0))
  (func $use (param i32 i32))
  (func $use1 (param i32))
  ;; Control: $x is read after collect(), so it is live across the call and spilled.
  (func $control
    (local $x i32)
    (local.set $x (call $make))
    (drop (call $collect))
    (call $use1 (local.get $x))
  )
  ;; make()'s result waits on the value stack while collect() runs: not spilled.
  (func $operand
    (call $use (call $make) (call $collect))
  )
  ;; Same, through a local: local.get $x is evaluated before collect(), so $x
  ;; is dead across the call, and the value on the value stack is not spilled.
  (func $local-operand
    (local $x i32)
    (local.set $x (call $make))
    (call $use (local.get $x) (call $collect))
  )
)
