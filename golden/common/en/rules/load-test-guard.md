# Guardrails for load-generating tests

Tests that generate load (spinning the CPU, heavy parallelism, long repeated runs) can make a person's working machine unusable. Follow these before running one.

- Place a load-generating test only when one of the following holds:
  (1) the load occurs in normal use;
  (2) you want to measure behavior under load itself (speed, limits);
  (3) the failure you need to confirm occurs only under load, and there is no way to reproduce it without load (swapping a function, a synchronization marker, and so on).
- When you plan or request a load test, write down three things:
  the failure you want to find, how often that state occurs in normal use, and whether you tried to reproduce it without load.
  If it can be reproduced without load, do not place a load test.
- When load is needed, decide the intensity cap (number of processes, share of cores, duration) and how to stop it before starting.
  When the load could disturb work or service on a machine a person uses for work, or one that runs live services, tell the person and get permission before you start.
- Once the cause is known, replace the load test with a test that reproduces it every time without load, and stop the load test.
  Show that it is fixed with a test that always fails before the fix and always passes after it. Repeating the same test and seeing 0 failures is not proof of a fix.
  (Even to say "the failure rate is under 10%" from 0 failures takes about 30 consecutive runs under the same conditions. That is not proof of safety.)
- A plan or table that sets the number of runs or the duration must also state how much of the person's machine is occupied, and for how long.
