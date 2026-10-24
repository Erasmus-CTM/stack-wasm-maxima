/* SPDX-License-Identifier: AGPL-3.0-or-later
 * Test fixture for the pinned BDWGC implementation. No collector code changes.
 * Private headers expose occupancy; all pushes use the real public GC APIs.
 */
#include "private/gc_priv.h"
#include "private/gc_pmark.h"
#include "gc_mark.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define RANGE_COUNT 6
#define CHAIN_RANGES 3
#define COLLECTIONS 4
#define MAX_OBJECTS 64
#define MAGIC ((GC_word)0x43544d51)

struct object { GC_word magic, id; struct object *child; };
struct cblock { GC_word locked; void *roots[2]; };
struct fixture {
    void *roots[RANGE_COUNT][3];
    struct cblock *locked;
    void *chained[CHAIN_RANGES][2];
    void *weak[MAX_OBJECTS]; /* System malloc storage: never a strong GC root. */
    GC_word hidden[MAX_OBJECTS];
    unsigned live[MAX_OBJECTS];
    unsigned count, extra, dead, unlocked, unlocked_child;
    unsigned callbacks, chain_callbacks, collections, active, recoveries;
    size_t capacity, max_capacity, prefills;
    int eager, chain_eager, nearfull, graphs;
};
static struct fixture *fixture;
static GC_push_other_roots_proc previous_roots;
static GC_push_other_roots_proc chained_roots;
static GC_word padding_root; /* A valid, zero-containing range descriptor. */

static void check(int condition, const char *message)
{
    if (!condition) {
        fprintf(stderr, "CTM-GC-ROOT-FAIL|%s\n", message);
        exit(2);
    }
}

static size_t capacity(void)
{
    return ((word)GC_mark_stack_limit - (word)GC_mark_stack) / sizeof(mse);
}

static size_t occupied(void)
{
    return ((word)GC_mark_stack_top + sizeof(mse) - (word)GC_mark_stack)
           / sizeof(mse);
}

static void check_capacity(void)
{
    size_t actual = capacity();
    if (fixture->nearfull && fixture->graphs) {
        /* Real pointerful work may use BDWGC's ordinary overflow recovery.
         * No test code alters capacity or requests a larger initial stack. */
        check(actual >= fixture->capacity
              && actual <= fixture->capacity * (1U << COLLECTIONS),
              "unbounded collector recovery growth");
    } else {
        check(actual == fixture->capacity, "mark-stack capacity changed");
    }
    if (actual > fixture->max_capacity) fixture->max_capacity = actual;
}

static void push_range(void *bottom, void *top)
{
    if (fixture->eager) GC_push_all_eager(bottom, top);
    else GC_push_all(bottom, top);
}

static void chain_scanner(void)
{
    unsigned i;
    ++fixture->chain_callbacks;
    if (fixture->active) {
        if (fixture->nearfull)
            fprintf(stderr, "CTM-GC-ROOT-CHAIN|mode=%s|ranges=%u|used=%lu|capacity=%lu\n",
                    fixture->chain_eager ? "eager" : "lazy", CHAIN_RANGES,
                    (unsigned long)occupied(), (unsigned long)capacity());
        /* This callback's implementation is independent of ECL-style scanning.
         * Three lazy descriptors exhaust the near-full case's two free slots. */
        for (i = 0; i < CHAIN_RANGES; ++i) {
            if (fixture->chain_eager)
                GC_push_all_eager(fixture->chained[i], fixture->chained[i] + 2);
            else GC_push_all(fixture->chained[i], fixture->chained[i] + 2);
        }
    }
    if (previous_roots) previous_roots();
}

static void roots_scanner(void)
{
    unsigned i;
    ++fixture->callbacks;
    check_capacity();
    if (fixture->active && fixture->nearfull) {
        /* No synthetic mark routine or limit change: real GC_push_all queues
         * valid descriptors until only two entries remain. Atomic referents
         * let eager scanning mark them without scheduling their contents. */
        check(occupied() <= capacity() - 2, "unexpected prefill occupancy");
        while (occupied() < capacity() - 2) {
            GC_push_all(&padding_root, &padding_root + 1);
            ++fixture->prefills;
        }
        fprintf(stderr, "CTM-GC-ROOT-NEARFULL|used=%lu|capacity=%lu\n",
                (unsigned long)occupied(), (unsigned long)capacity());
    }
    if (fixture->active) {
        /* Same locked-block rule as ECL: scan contents and separately retain
         * the block itself. Unlocked blocks are deliberately not scanned. */
        struct cblock *dll = fixture->locked;
        check(dll->locked == 1, "locked block changed");
        if (fixture->eager) GC_push_all_eager(dll, dll + 1);
        else GC_push_conditional(dll, dll + 1, 1);
        GC_set_mark_bit(dll);
        /* cl_core, core symbols, run, frame, binding stacks, environment. */
        for (i = 0; i < RANGE_COUNT; ++i)
            push_range(fixture->roots[i], fixture->roots[i] + 3);
    }
    if (chained_roots) chained_roots();
    if (fixture->active && fixture->nearfull && fixture->graphs
        && GC_mark_state == MS_INVALID && GC_mark_stack_too_small) {
        ++fixture->recoveries;
        fprintf(stderr, "CTM-GC-ROOT-RECOVERY|used=%lu|capacity=%lu\n",
                (unsigned long)occupied(), (unsigned long)capacity());
    }
    check_capacity();
}

static unsigned remember(void *object, unsigned live)
{
    unsigned i = fixture->count++;
    check(i < MAX_OBJECTS, "fixture object limit");
    fixture->weak[i] = object;
    fixture->hidden[i] = (GC_word)GC_HIDE_POINTER(object);
    fixture->live[i] = live;
    check(GC_general_register_disappearing_link(&fixture->weak[i], object)
          == GC_SUCCESS, "weak-link registration");
    return i;
}

static struct object *new_object(unsigned live, int graph)
{
    struct object *p = graph ? GC_malloc(sizeof(*p)) : GC_malloc_atomic(sizeof(*p));
    unsigned i;
    check(p != NULL, "sentinel allocation");
    i = remember(p, live);
    p->magic = MAGIC;
    p->id = i;
    p->child = graph ? new_object(live, 0) : NULL;
    return p;
}

GC_ATTR_NOINLINE static void allocate_fixture(void)
{
    unsigned i, j;
    struct cblock *unlocked;
    for (i = 0; i < RANGE_COUNT; ++i)
        for (j = 0; j < 2; ++j)
            fixture->roots[i][j] = (char *)new_object(1, fixture->graphs) + j;
    fixture->locked = GC_malloc_atomic(sizeof(*fixture->locked));
    check(fixture->locked != NULL, "cblock allocation");
    remember(fixture->locked, 2);
    fixture->locked->locked = 1;
    for (j = 0; j < 2; ++j) {
        fixture->locked->roots[j] = (char *)new_object(1, fixture->graphs) + j;
    }
    for (i = 0; i < CHAIN_RANGES; ++i)
        for (j = 0; j < 2; ++j)
            fixture->chained[i][j] = (char *)new_object(1, fixture->graphs) + j;
    /* Offset two is deliberately unregistered. Eager's documented acceptance
     * of arbitrary interior pointers is reported, not hidden as equivalence. */
    fixture->extra = fixture->count;
    fixture->roots[0][2] = (char *)new_object(0, 0) + 2;
    fixture->dead = fixture->count;
    (void)new_object(0, 0);
    unlocked = GC_malloc_atomic(sizeof(*unlocked));
    check(unlocked != NULL, "unlocked block allocation");
    fixture->unlocked = remember(unlocked, 0);
    unlocked->locked = 0;
    fixture->unlocked_child = fixture->count;
    unlocked->roots[0] = new_object(0, 0);
    unlocked->roots[1] = NULL;
}

/* Remove allocation/verification temporaries from the inactive C stack.
 * Current C stack scanning remains enabled in the real collector. */
GC_ATTR_NOINLINE static void scrub_stack(void)
{
    volatile GC_word words[16384];
    unsigned i;
    for (i = 0; i < 16384; ++i) words[i] = 0;
    GC_noop1(words[0]);
    (void)GC_clear_stack(NULL);
}

static void *verify_survival(void *ignored)
{
    unsigned i;
    (void)ignored;
    for (i = 0; i < fixture->count; ++i) {
        int expected = fixture->active
            && (fixture->live[i] || (i == fixture->extra && fixture->eager));
        check((fixture->weak[i] != NULL) == expected,
              expected ? "required root was lost" : "unrooted control retained");
        if (expected && fixture->live[i] != 2) {
            struct object *p = GC_REVEAL_POINTER(fixture->hidden[i]);
            check(p == fixture->weak[i] && p->magic == MAGIC && p->id == i,
                  "sentinel identity/content changed");
            if (p->child) check(p->child->magic == MAGIC, "transitive child lost");
        }
    }
    return NULL;
}

int main(int argc, char **argv)
{
    unsigned round;
    int incremental;
    check(argc == 6, "usage: fixture lazy|eager nearfull|ordinary atomic|graph 0|1 lazy|eager");
    check((strcmp(argv[1], "lazy") == 0 || strcmp(argv[1], "eager") == 0)
          && (strcmp(argv[2], "nearfull") == 0 || strcmp(argv[2], "ordinary") == 0)
          && (strcmp(argv[3], "atomic") == 0 || strcmp(argv[3], "graph") == 0)
          && (strcmp(argv[4], "0") == 0 || strcmp(argv[4], "1") == 0)
          && (strcmp(argv[5], "lazy") == 0 || strcmp(argv[5], "eager") == 0),
          "invalid fixture mode");
    fixture = calloc(1, sizeof(*fixture));
    check(fixture != NULL, "fixture storage allocation");
    fixture->eager = strcmp(argv[1], "eager") == 0;
    fixture->nearfull = strcmp(argv[2], "nearfull") == 0;
    fixture->graphs = strcmp(argv[3], "graph") == 0;
    fixture->chain_eager = strcmp(argv[5], "eager") == 0;
    incremental = strcmp(argv[4], "1") == 0;
    GC_set_no_dls(1);
    GC_set_all_interior_pointers(0);
    GC_init();
    if (incremental) GC_enable_incremental();
    check(GC_get_all_interior_pointers() == 0, "interior-pointer policy changed");
    check(GC_get_version() == ((8 << 16) | (2 << 8) | 8), "wrong collector version");
    check(GC_is_incremental_mode() == incremental,
          "requested incremental mode unavailable");
    GC_register_displacement(1);
    GC_clear_roots();
    GC_disable();
    fixture->capacity = capacity();
    fixture->max_capacity = fixture->capacity;
    check(fixture->capacity >= 8, "unexpected original mark-stack capacity");
    allocate_fixture();
    previous_roots = GC_get_push_other_roots();
    GC_set_push_other_roots(chain_scanner);
    chained_roots = GC_get_push_other_roots();
    GC_set_push_other_roots(roots_scanner);
    fixture->active = 1;
    GC_enable();
    printf("CTM-GC-ROOT-START|pointerBits=%u|incremental=%d|capacity=%lu|objects=%u"
           "|chain=%s|chainRanges=%u|previousCollectorCallback=%d\n",
           (unsigned)(8 * sizeof(void *)), GC_is_incremental_mode(),
           (unsigned long)fixture->capacity, fixture->count,
           argv[5], CHAIN_RANGES, previous_roots != NULL);
    fflush(stdout);
    for (round = 0; round < COLLECTIONS; ++round) {
        scrub_stack();
        GC_gcollect();
        ++fixture->collections;
        GC_call_with_alloc_lock(verify_survival, NULL);
        check_capacity();
        check(GC_is_incremental_mode() == incremental, "incremental mode changed");
    }
    fixture->active = 0;
    scrub_stack();
    GC_gcollect();
    GC_call_with_alloc_lock(verify_survival, NULL);
    check_capacity();
    check(fixture->callbacks == fixture->chain_callbacks, "chained callback skipped");
    check(!fixture->nearfull || fixture->prefills > 0, "near-full precondition missing");
    check(!(fixture->nearfull && fixture->graphs) || fixture->recoveries > 0,
          "ordinary worklist overflow recovery was not exercised");
    printf("CTM-GC-ROOT-PASS|mode=%s|pressure=%s|objects=%s|pointerBits=%u"
           "|incremental=%d|capacity=%lu|collections=%u|callbacks=%u"
           "|arbitraryInteriorRetained=%d|rootsReleased=1|chain=%s"
           "|chainCallbacks=%u|finalCapacity=%lu|maxCapacity=%lu|recoveries=%u\n",
           argv[1], argv[2], argv[3], (unsigned)(8 * sizeof(void *)),
           incremental, (unsigned long)fixture->capacity, fixture->collections,
           fixture->callbacks, fixture->eager, argv[5], fixture->chain_callbacks,
           (unsigned long)capacity(), (unsigned long)fixture->max_capacity,
           fixture->recoveries);
    return 0;
}
