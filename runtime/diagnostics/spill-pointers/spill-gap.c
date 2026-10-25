/* SPDX-License-Identifier: AGPL-3.0-or-later
 * A Boehm GC pointer held only on the Wasm value stack across a nested call.
 * Binaryen's --spill-pointers does not spill it; --flatten first does.
 *
 * Per round it reports whether the collector freed the object (a disappearing
 * link is cleared), whether its contents were overwritten, and how many copies
 * of its address the shadow stack held at the collection, inside main's live
 * frame (a real spill) or below it (stale words that only keep it by chance).
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <emscripten/stack.h>
#include "gc.h"

#define LIVE 0x51A7E5u
#define FILL 0xDEADu
typedef struct { unsigned magic, id; void *pad[2]; } object;

static GC_hidden_pointer link_slot;
static unsigned long target, main_sp;
static unsigned freed, corrupted, spilled_rounds, stale_rounds;

__attribute__((noinline)) static object *alloc_deep(unsigned id) {
  object *o = GC_MALLOC(sizeof(object));
  o->magic = LIVE; o->id = id;
  target = (unsigned long)o;
  link_slot = GC_HIDE_POINTER(o);
  GC_general_register_disappearing_link((void **)&link_slot, o);
  return o;
}
static object *(*volatile alloc_fn)(unsigned) = alloc_deep;

__attribute__((noinline)) static void touch(char *pad) { memset(pad, 0, 2048); }
static void (*volatile touch_fn)(char *) = touch;

/* The allocator frames leave copies of the result on the shadow stack, and
   spill areas sit at the top of each frame. Padding make()'s own frame puts
   them all below churn()'s frame, where scrub() clears them, so that a stale
   word cannot keep the object alive by accident. */
__attribute__((noinline)) static object *make(unsigned id) {
  char pad[2048];
  touch_fn(pad); /* escapes, so the optimizer keeps the padding */
  return alloc_fn(id);
}

/* Overwrite dead stack words below this frame. */
__attribute__((noinline)) static void scrub(void) {
  volatile char block[16384];
  memset((char *)block, 0, sizeof block);
}

/* Counts shadow-stack words holding the object's address. */
__attribute__((noinline)) static void census(void) {
  unsigned long sp = emscripten_stack_get_current(), base = emscripten_stack_get_base();
  int spilled = 0, stale = 0;
  for (unsigned long p = sp & ~3ul; p < base; p += 4)
    if (*(unsigned long *)p == target) {
      if (p >= main_sp) spilled = 1; else stale = 1;
    }
  spilled_rounds += spilled;
  stale_rounds += stale;
}

/* Collects, then reuses freed blocks of the same size with a fill pattern. */
__attribute__((noinline)) static object *churn(unsigned id) {
  scrub();
  census();
  GC_gcollect();
  object *last = 0;
  for (int i = 0; i < 256; i++) {
    object *o = GC_MALLOC(sizeof(object));
    o->magic = FILL; o->id = id; last = o;
  }
  return last;
}

__attribute__((noinline)) static int intact(object *first, object *second, unsigned id) {
  int ok = first->magic == LIVE && first->id == id && second->magic == FILL;
  if (link_slot == 0) freed++;
  else GC_unregister_disappearing_link((void **)&link_slot);
  if (!ok) corrupted++;
  return ok;
}

/* Indirect calls keep Binaryen from inlining, so make()'s result stays an
   operand on the Wasm value stack, not a local, while churn() runs. */
static object *(*volatile make_fn)(unsigned) = make;
static object *(*volatile churn_fn)(unsigned) = churn;
static int (*volatile intact_fn)(object *, object *, unsigned) = intact;

int main(int argc, char **argv) {
  unsigned rounds = argc > 1 ? (unsigned)atoi(argv[1]) : 2000;
  GC_INIT();
  for (unsigned id = 0; id < rounds; id++) {
    main_sp = emscripten_stack_get_current();
    /* make(id) is evaluated first; its result waits while churn(id) runs. */
    intact_fn(make_fn(id), churn_fn(id), id);
  }
  printf("{\"rounds\": %u, \"freed\": %u, \"lost\": %u, \"spilledRounds\": %u, \"staleRounds\": %u, "
         "\"collections\": %lu}\n", rounds, freed, corrupted, spilled_rounds, stale_rounds,
         (unsigned long)GC_get_gc_no());
  return 0;
}
