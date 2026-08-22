---
id: bitemporal
title: Bitemporal Modeling
author: '[[ada]]'
tags: [theory, storage]
---

Bitemporal storage keeps _valid time_ (when the fact held in the world) separate from
_transaction time_ (when the system learned it). Corrections rewrite history without
losing the record of what was believed before.

Builds on [temporal graphs](./temporal-graphs.md).

![[diagram.png]]
