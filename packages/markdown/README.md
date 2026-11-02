# @fulcrum/markdown

## known streaming limits

The current incremental parser has three known limits in deeply nested containers:

- a 100 KB `blockquote > list > blockquote` stream can rescan the retained container, so late deltas do about 2.3 times the work of early deltas;
- the unfinished nested-table prefix `>   > |` can briefly show its raw pipe;
- the 1-byte mixed-quote benchmark has produced a 37.260 ms worst delta against the 16 ms target.

These limits are tracked by the known-fail tests in `test/recursive-containers.test.tsx`. Final rendering remains equal to one-shot parsing.
