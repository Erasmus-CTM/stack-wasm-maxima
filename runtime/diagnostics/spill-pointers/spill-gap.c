/* SPDX-License-Identifier: AGPL-3.0-or-later
 * A Boehm GC pointer held only on the Wasm value stack across a nested call.
 * Binaryen's --spill-pointers does not spill it; --flatten first does.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "gc.h"

#define LIVE 0x51A7E5u
#define FILL 0xDEADu
typedef struct { unsigned magic, id; void *pad[2]; } object;

__attribute__((noinline)) static object *make(unsigned id) {
  object *o = GC_MALLOC(sizeof(object));
  o->magic = LIVE; o->id = id;
  return o;
}

/* Overwrite dead stack words so stale copies cannot keep the result alive. */
__attribute__((noinline)) static void scrub(void) {
  volatile char block[16384];
  memset((char *)block, 0, sizeof block);
}

/* Collects, then reuses freed blocks of the same size with a fill pattern. */
__attribute__((noinline)) static object *churn(unsigned id) {
  scrub();
  GC_gcollect();
  object *last = 0;
  for (int i = 0; i < 256; i++) {
    object *o = GC_MALLOC(sizeof(object));
    o->magic = FILL; o->id = id; last = o;
  }
  return last;
}

__attribute__((noinline)) static int intact(object *first, object *second, unsigned id) {
  return first->magic == LIVE && first->id == id && second->magic == FILL;
}

/* Indirect calls keep Binaryen from inlining, so make()'s result stays an
   operand on the Wasm value stack, not a local, while churn() runs. */
static object *(*volatile make_fn)(unsigned) = make;
static object *(*volatile churn_fn)(unsigned) = churn;
static int (*volatile intact_fn)(object *, object *, unsigned) = intact;

int main(int argc, char **argv) {
  unsigned rounds = argc > 1 ? (unsigned)atoi(argv[1]) : 2000, lost = 0;
  GC_INIT();
  for (unsigned id = 0; id < rounds; id++)
    /* make(id) is evaluated first; its result waits while churn(id) runs. */
    if (!intact_fn(make_fn(id), churn_fn(id), id)) lost++;
  printf("{\"rounds\": %u, \"lost\": %u, \"collections\": %lu}\n", rounds, lost, (unsigned long)GC_get_gc_no());
  return 0;
}
