/* SPDX-License-Identifier: AGPL-3.0-or-later
 * The spill-pointers value-stack gap through ECL's public API, as an embedding
 * program linked against libecl.a (ECL INSTALL, "Build an external program").
 * A fresh cons waits on the Wasm value stack while a nested call collects.
 *
 * Per round it reports whether the collector freed the cons (a disappearing
 * link is cleared), whether its contents were overwritten, and how many copies
 * of its address the shadow stack held at the collection, inside main's live
 * frame (a real spill) or below it (stale words that only keep it by chance).
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ecl/ecl.h>
#include <ecl/gc/gc.h>
#include <emscripten/stack.h>

#define LIVE 51717
#define FILL 57005

static GC_hidden_pointer link_slot;
static unsigned long target, main_sp;
static unsigned freed, corrupted, spilled_rounds, stale_rounds;

__attribute__((noinline)) static cl_object alloc_deep(unsigned id) {
  cl_object c = ecl_cons(ecl_make_fixnum(id), ecl_make_fixnum(LIVE));
  void *base = GC_base((void *)c);
  target = (unsigned long)base;
  link_slot = GC_HIDE_POINTER(base);
  GC_general_register_disappearing_link((void **)&link_slot, base);
  return c;
}
static cl_object (*volatile alloc_fn)(unsigned) = alloc_deep;

/* The allocator frames leave copies of the result on the shadow stack, and
   spill areas sit at the top of each frame. Padding make()'s own frame puts
   them all below churn()'s frame, where scrub() clears them, so that a stale
   word cannot keep the cons alive by accident. */
__attribute__((noinline)) static void touch(char *pad) { memset(pad, 0, 2048); }
static void (*volatile touch_fn)(char *) = touch;

__attribute__((noinline)) static cl_object make(unsigned id) {
  char pad[2048];
  touch_fn(pad); /* escapes, so the optimizer keeps the padding */
  return alloc_fn(id);
}

/* Overwrite dead stack words below this frame. */
__attribute__((noinline)) static void scrub(void) {
  volatile char block[16384];
  memset((char *)block, 0, sizeof block);
}

/* Counts shadow-stack words holding the cons address (untagged or tagged). */
__attribute__((noinline)) static void census(void) {
  unsigned long sp = emscripten_stack_get_current(), base = emscripten_stack_get_base();
  int spilled = 0, stale = 0;
  for (unsigned long p = sp & ~3ul; p < base; p += 4) {
    unsigned long word = *(unsigned long *)p;
    if (word == target || word == target + 1) {
      if (p >= main_sp) spilled = 1; else stale = 1;
    }
  }
  spilled_rounds += spilled;
  stale_rounds += stale;
}

/* Collects through ECL, then reuses freed conses with a fill pattern. */
__attribute__((noinline)) static cl_object churn(unsigned id) {
  cl_object last = ECL_NIL;
  scrub();
  census();
  si_gc(0);
  for (int i = 0; i < 256; i++) last = ecl_cons(ecl_make_fixnum(-1), ecl_make_fixnum(FILL));
  return last;
}

__attribute__((noinline)) static int intact(cl_object first, cl_object second, unsigned id) {
  int ok = ECL_CONSP(first) && ECL_CONS_CAR(first) == ecl_make_fixnum(id) &&
           ECL_CONS_CDR(first) == ecl_make_fixnum(LIVE) && ECL_CONSP(second);
  if (link_slot == 0) freed++;
  else GC_unregister_disappearing_link((void **)&link_slot);
  if (!ok) corrupted++;
  return ok;
}

/* Indirect calls keep Binaryen from inlining, so make()'s result stays an
   operand on the Wasm value stack while churn() runs. This is the shape of
   ECL-compiled Lisp such as (f (make-thing) (churn)) -> f(make(), churn()). */
static cl_object (*volatile make_fn)(unsigned) = make;
static cl_object (*volatile churn_fn)(unsigned) = churn;
static int (*volatile intact_fn)(cl_object, cl_object, unsigned) = intact;

int main(int argc, char **argv) {
  unsigned rounds = argc > 1 ? (unsigned)atoi(argv[1]) : 2000;
  /* Flattening enlarges every frame of the statically linked ECL as well. */
  ecl_set_option(ECL_OPT_C_STACK_SIZE, 16 * 1024 * 1024);
  cl_boot(argc, argv);
  for (unsigned id = 0; id < rounds; id++) {
    main_sp = emscripten_stack_get_current();
    intact_fn(make_fn(id), churn_fn(id), id);
  }
  printf("{\"rounds\": %u, \"freed\": %u, \"lost\": %u, \"spilledRounds\": %u, \"staleRounds\": %u, "
         "\"collections\": %lu}\n", rounds, freed, corrupted, spilled_rounds, stale_rounds,
         (unsigned long)GC_get_gc_no());
  cl_shutdown();
  return 0;
}
