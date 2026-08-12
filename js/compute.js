// ============================================================
//  CALCULS : statistiques mensuelles, portefeuilles, agrégations
// ============================================================

function trUserShare(settings, monthData) {
  if (!monthData) return 0;
  const total = (monthData.tr || []).reduce((s, t) => s + (t.amount || 0), 0);
  const face = Number(settings?.trFaceValue) || 0;
  const own = Number(settings?.trOwnShare) || 0;
  // Garde-fou : une valeur faciale ou une part utilisateur nulle/négative
  // (corruption de données ou saisie invalide) ne doit jamais produire
  // une part TR négative dans la cascade des soldes.
  if (face <= 0 || own <= 0) return 0;
  return r2(total * own / face);
}

function computeMonth(checking, mKey) {
  const m = checking.months[mKey];
  if (!m) return null;
  // Modèle "1 seul tableau" : m.operations contient toutes les ops avec type.
  // Pour les calculs, on filtre par type. Rétro-compat avec l'ancien modèle
  // (entries/exits séparés) : Adapter._normalizeCheckingAccount migre déjà.
  const ops = m.operations || [];
  const entries = ops.filter(o => o.type === 'in');
  const exits   = ops.filter(o => o.type === 'out');
  const entriesAll = entries.reduce((s, e) => s + (e.amount || 0), 0);
  const entriesPointed = entries.filter(e => e.pointed).reduce((s, e) => s + (e.amount || 0), 0);
  const exitsAll = exits.reduce((s, e) => s + (e.amount || 0), 0);
  const exitsPointed = exits.filter(e => e.pointed).reduce((s, e) => s + (e.amount || 0), 0);

  const trTotal = (m.tr || []).reduce((s, t) => s + (t.amount || 0), 0);
  const userShare = trUserShare(checking.settings, m);

  // Deux carries distincts, obtenus en UN SEUL appel (v614) :
  // - pointed   : ancré sur le solde POINTÉ du mois précédent —
  //   "vérité bancaire", ce qu'il reste vraiment fin de mois précédent.
  // - projected : ancré sur la PROJECTION fin de mois précédent —
  //   vue prospective, propage les non-pointés en cascade. Les deux
  //   convergent dès qu'un mois est entièrement pointé.
  const carry = computeCarryOver(checking, mKey);
  return {
    entriesAll: r2(entriesAll), entriesPointed: r2(entriesPointed),
    exitsAll: r2(exitsAll), exitsPointed: r2(exitsPointed),
    trTotal: r2(trTotal),
    trUserShare: userShare,
    trEmployerShare: r2(trTotal - userShare),
    // L'UI affiche stats.carry sous "Reste mois préc." → c'est bien le
    // pointé qui correspond ("ce qu'il reste vraiment en banque").
    carry: r2(carry.pointed),
    // Exposé pour le détail dépliable de la projection (v517) : c'est LUI
    // qui entre dans la formule de balanceProjected, pas carry.pointed.
    carryProjected: r2(carry.projected),
    balancePointed: r2(carry.pointed + entriesPointed - exitsPointed),
    balanceProjected: r2(carry.projected + entriesAll - exitsAll),
  };
}

// Reports du mois précédent : renvoie { pointed, projected } — les DEUX
// valeurs en un seul appel.
//
// ⚠️ NE JAMAIS revenir à deux appels séparés (un par mode), comme c'était
// le cas jusqu'en v613. computeMonth a besoin des deux reports ; en les
// demandant séparément, chaque appel relançait computeMonth sur le mois
// précédent, qui relançait deux fois à son tour → l'arbre d'appels
// DOUBLAIT à chaque mois de la série, les deux branches recalculant
// exactement la même chose. Coût mesuré pour UN résultat, sur une série
// de mois consécutifs :
//     6 mois →         63 appels        12 mois →      4 095 appels
//    18 mois →    262 143 appels        24 mois → 16 777 215 appels (~1 min)
// Ici, un seul appel par mois : 24 mois → 24 appels.
// (Les 5 appelants de computeMonth visent tous le mois le PLUS PROFOND :
//  consolidated.js, checking.js ×2, app.js snapshot, backups.js.)
//
// Aucune mémoïsation, volontairement : rien n'est conservé entre deux
// appels, donc modifier un mois ancien reste immédiatement répercuté sur
// toute la chaîne des mois suivants (cf. updateTRRefundsCascade).
function computeCarryOver(checking, mKey) {
  const prev = prevMonthKey(mKey);
  if (checking.months[prev]) {
    const prevStats = computeMonth(checking, prev);
    if (!prevStats) return { pointed: 0, projected: 0 };
    return { pointed: prevStats.balancePointed, projected: prevStats.balanceProjected };
  }
  // Pas de mois précédent : le tout premier mois de la série part du solde
  // initial, les autres (après un trou dans la série) partent de 0. Même
  // valeur pour les deux reports — comportement identique à l'avant-v614,
  // où les deux modes tombaient sur cette même expression.
  const sortedKeys = Object.keys(checking.months).sort();
  const base = (sortedKeys[0] === mKey) ? (checking.initialBalance || 0) : 0;
  return { pointed: base, projected: base };
}

// Calcule une date ISO YYYY-MM-DD à partir d'un dayOfMonth (1-31) et d'un
// mKey (YYYY-MM). Renvoie null si le jour n'existe pas dans le mois cible
// (ex. récurrent au 31 dans un mois de 30 jours, ou au 30 en février) :
// la ligne sera créée sans date, à l'utilisateur de la corriger via la chip.
function dateFromDayOfMonth(mKey, day) {
  if (!day || typeof day !== 'number' || day < 1) return null;
  const [y, m] = mKey.split('-').map(Number);
  const maxDay = new Date(y, m, 0).getDate(); // jour 0 du mois suivant = dernier jour du mois courant
  if (day > maxDay) return null;
  return `${mKey}-${String(day).padStart(2, '0')}`;
}

function instantiateRecurring(template, monthKeyForTR, checking, datesMode = false) {
  const trOK = checking.settings.trEnabled !== false;
  const date = datesMode ? dateFromDayOfMonth(monthKeyForTR, template.dayOfMonth) : null;
  // Le type 'in'/'out' provient du template récurrent (modèle unifié).
  // Si template.type est absent (ancien modèle migré au load), on lit
  // une éventuelle annotation type ; à défaut on tombe sur 'out'.
  const type = template.type || 'out';
  if (template.isComposite) {
    const components = (template.components || [])
      .filter(c => !c.isTRRefund || trOK)
      .map(c => {
        const newC = { id: uid(), label: c.label, amount: c.amount };
        if (c.isTRRefund) {
          newC.isTRRefund = true;
          const prev = prevMonthKey(monthKeyForTR);
          const prevUserShare = checking.months[prev] ? trUserShare(checking.settings, checking.months[prev]) : 0;
          newC.amount = -prevUserShare;
        }
        return newC;
      });
    const total = r2(components.reduce((s, c) => s + (c.amount || 0), 0));
    const row = { id: uid(), label: template.label, amount: total, pointed: false, isComposite: true, components, type };
    if (date) row.date = date;
    return row;
  }
  if (template.isTRRefund && !trOK) return null;
  const row = { id: uid(), label: template.label, amount: template.amount, pointed: false, type };
  if (template.isTRRefund) {
    row.isTRRefund = true;
    const prev = prevMonthKey(monthKeyForTR);
    const prevUserShare = checking.months[prev] ? trUserShare(checking.settings, checking.months[prev]) : 0;
    row.amount = -prevUserShare;
  }
  if (date) row.date = date;
  return row;
}

function createMonthData(checking, mKey, datesMode = false) {
  // Modèle unifié : on instancie tous les récurrents en UN SEUL tableau
  // operations[], avec le type propagé sur chaque ligne.
  // Rétro-compat : si recurringOperations n'existe pas (vieux modèle),
  // on assemble depuis recurringIncome + recurringExpense.
  const recOps = Array.isArray(checking.settings.recurringOperations)
    ? checking.settings.recurringOperations
    : [
        ...((checking.settings.recurringIncome  || []).map(r => ({ ...r, type: 'in'  }))),
        ...((checking.settings.recurringExpense || []).map(r => ({ ...r, type: 'out' }))),
      ];
  const operations = recOps.map(r => instantiateRecurring(r, mKey, checking, datesMode)).filter(Boolean);
  return { operations, tr: [] };
}

// ============================================================
//  Épargne — solde calculé et stats
//  Un livret a un solde initial (initialBalance, fallback sur le
//  champ balance pour rétro-compat) auquel s'ajoutent les opérations
//  enregistrées (versements et intérêts en positif, retraits en
//  négatif). Toutes les opérations comptent peu importe leur date :
//  c'est à l'utilisateur de ne pas saisir d'opérations antérieures
//  au solde initial (pour éviter un double comptage).
// ============================================================
function computeSavingsBalance(saving) {
  const initial = saving?.initialBalance ?? saving?.balance ?? 0;
  const ops = saving?.operations || [];
  let delta = 0;
  for (const op of ops) {
    const a = Number(op.amount) || 0;
    if (op.type === 'out') delta -= a;
    else delta += a; // 'in' et 'interest'
  }
  return r2(initial + delta);
}

function computeSavingsStats(saving) {
  const ops = saving?.operations || [];
  let totalIn = 0, totalOut = 0, totalInterest = 0;
  for (const op of ops) {
    const a = Number(op.amount) || 0;
    if (op.type === 'in') totalIn += a;
    else if (op.type === 'out') totalOut += a;
    else if (op.type === 'interest') totalInterest += a;
  }
  return {
    versements: r2(totalIn),
    retraits: r2(totalOut),
    interets: r2(totalInterest),
    count: ops.length,
  };
}

// Le mois `month` porte-t-il un remboursement TR auto dont le montant
// DIFFÈRE de `refundAmount` ? Sert uniquement à savoir si un garde-fou a
// réellement empêché un changement (→ on le signale à l'utilisateur) ou s'il
// n'y avait de toute façon rien à faire (→ on se tait).
function _wouldChangeTRRefund(month, refundAmount) {
  return (month.operations || []).some(o => {
    if (o.type !== 'out') return false;
    if (o.isTRRefund && !o.isComposite) return o.amount !== refundAmount;
    if (o.isComposite && o.components) {
      const trComp = o.components.find(c => c.isTRRefund);
      return !!trComp && trComp.amount !== refundAmount;
    }
    return false;
  });
}

// Recalcule le remboursement TR auto du mois SUIVANT mKey, d'après les
// paiements TR de mKey.
//
// Renvoie la LISTE des mois source dont la mise à jour a été REFUSÉE par un
// garde-fou : `[]` ou `[{ month, reason }]`, `reason` valant 'frozen' ou
// 'rate'. updateTRRefundsCascade concatène, l'appelant en fait un toast via
// trSkipMessage. Sans ce retour, un saut serait invisible et passerait pour
// un bug.
// ⚠️ C'était un simple COMPTEUR jusqu'à la date d'effet du taux : le mois et
// le motif sont désormais nécessaires pour nommer, dans le toast, la ligne
// qu'il faut corriger à la main.
function updateTRRefundsForMonth(checking, mKey) {
  if (checking.settings.trEnabled === false) return [];
  const next = nextMonthKey(mKey);
  const nextMonth = checking.months[next];
  if (!nextMonth) return []; // mois pas encore créé : instantiateRecurring s'en chargera
  const refundAmount = -trUserShare(checking.settings, checking.months[mKey] || { tr: [] });

  // ⚠️ DEUX GARDE-FOUS — ne pas les retirer (bug mesuré le 28/07/2026).
  //
  // 1) Mois figé = lecture seule. Le garde-fou de gel de checking.js vit dans
  //    updateMonth et ne protège que le mois ÉDITÉ ; la cascade, elle,
  //    traverse tous les mois en aval. Sans ce test, défiger un mois ancien
  //    puis l'éditer réécrivait 12 mois FIGÉS.
  //
  // 2) Taux d'époque inconnu = intouchable, même défigé. Raison de fond : le
  //    taux TR n'est PAS historisé — trUserShare ne lit que
  //    settings.trFaceValue / trOwnShare, la valeur du JOUR. Or elle a changé
  //    (55 % de 2025-05 à 2026-05, valeur faciale de 10 € ; 45,08 % depuis
  //    2026-06). Recalculer un mois dont le taux d'alors différait lui
  //    appliquerait un taux qui n'avait pas cours : +173,01 € de sorties sur
  //    la série réelle, en silence.
  //    La vraie question est « le taux d'aujourd'hui était-il celui de ce
  //    mois-là ? ». `settings.trRateSince` (optionnel, saisi à la main dans
  //    les réglages du compte) y répond : on refuse les mois ANTÉRIEURS à
  //    cette date. Le test porte sur `mKey` — le mois dont les tickets sont
  //    sommés, donc celui auquel le taux s'applique — jamais sur le mois
  //    destinataire.
  //    ⚠️ Sans cette date (compte d'un autre utilisateur, date pas encore
  //    renseignée), on retombe sur le SUBSTITUT historique « mois révolu =
  //    intouchable ». Il donne la même réponse aujourd'hui, mais se dégrade
  //    tout seul : le simple passage du temps y transforme des refus
  //    justifiés en refus arbitraires (en septembre, juin et juillet
  //    seraient refusés alors que leur taux n'a pas bougé). D'où son
  //    rétrogradage en repli — ne pas le remettre en règle principale.
  //    Contrepartie assumée, inchangée : saisir des TR d'un mois refusé ne
  //    met plus à jour le mois suivant tout seul — il faut le corriger à la
  //    main, et le toast dit où. Cf. CLAUDE.md §10.
  const rateSince = checking.settings.trRateSince;
  const rateUnknown = rateSince ? mKey < rateSince : next < currentMonthKey();
  if (nextMonth.frozen || rateUnknown) {
    if (!_wouldChangeTRRefund(nextMonth, refundAmount)) return [];
    return [{ month: mKey, reason: nextMonth.frozen ? 'frozen' : 'rate' }];
  }

  // ⚠️ RÉÉCRITURE IMMUABLE — ne pas « simplifier » en remutant les objets.
  // Cette fonction reçoit des mois qui sont TOUJOURS partagés avec le state
  // React `checkingAccounts` (les appelants ne copient que l'objet `months`,
  // pas les mois eux-mêmes). Muter `e.amount` modifiait donc le state en
  // place ; invisible tant qu'un setState suivait, mais deux conséquences :
  //  1) plus aucune mutation d'état partagé ;
  //  2) l'IDENTITÉ de `checking.months[next]` ne change QUE si un montant a
  //     réellement bougé. C'est ce qui permet à l'appelant de savoir quels
  //     mois écrire par simple comparaison de références — sans compter les
  //     visites, qui sur-déclareraient (piège c du §11 : cette fonction
  //     réaffecte les composantes même quand la valeur est identique).
  // Le mois est reconstruit, jamais les mois voisins : `checking.months` est
  // un objet frais chez tous les appelants (ils font `{ ...checking.months }`),
  // donc l'affectation ci-dessous ne touche pas le state.
  let changed = false;
  const operations = (nextMonth.operations || []).map(o => {
    if (o.type !== 'out') return o;
    if (o.isTRRefund && !o.isComposite) {
      if (o.amount === refundAmount) return o;
      changed = true;
      return { ...o, amount: refundAmount };
    }
    if (o.isComposite && o.components) {
      const i = o.components.findIndex(c => c.isTRRefund);
      if (i < 0) return o;
      const components = o.components.slice();
      components[i] = { ...components[i], amount: refundAmount };
      const total = r2(components.reduce((s, c) => s + (c.amount || 0), 0));
      // Le total est recalculé même quand la composante TR n'a pas bougé
      // (comportement d'origine : il rattrape un composite désynchronisé) —
      // mais on ne remplace l'objet que si l'un des deux diffère vraiment.
      if (o.components[i].amount === refundAmount && o.amount === total) return o;
      changed = true;
      return { ...o, components, amount: total };
    }
    return o;
  });
  if (changed) checking.months[next] = { ...nextMonth, operations };
  return [];
}

// Propage le recalcul des TR auto sur TOUS les mois à partir de startKey
// (inclus). Utile quand on édite un mois ancien : le TR auto du mois M+1
// dépend du mois M, lui-même peut alimenter M+2, etc. Itère sur tous les
// mois connus triés.
//
// Renvoie la CONCATÉNATION des refus des garde-fous (même forme que
// updateTRRefundsForMonth). L'appelant doit en informer l'utilisateur : un
// recalcul silencieusement abandonné se lit comme un bug.
function updateTRRefundsCascade(checking, startKey) {
  if (checking.settings.trEnabled === false) return [];
  const sortedKeys = Object.keys(checking.months).sort();
  const skipped = [];
  for (const k of sortedKeys) {
    if (k < startKey) continue;
    skipped.push(...updateTRRefundsForMonth(checking, k));
  }
  return skipped;
}

// Texte du toast qui signale les refus ci-dessus. Il vit ICI, collé aux
// motifs qu'il traduit : écrit chez l'appelant, il se désynchroniserait du
// jour où un motif s'ajoute.
// Un seul mois refusé — le cas réel, puisqu'une modification ne change les
// tickets que d'un mois — est NOMMÉ, avec le mois où corriger à la main.
// Au-delà on retombe sur un décompte : un toast n'est pas une liste.
function trSkipMessage(skipped) {
  if (!skipped || skipped.length === 0) return '';
  if (skipped.length === 1) {
    const { month, reason } = skipped[0];
    const suivant = nextMonthKey(month);
    if (reason === 'frozen') {
      return `Tickets resto ${monthLabelDe(month)} non recalculés — ${monthLabel(suivant)} est figé. Défige-le pour reprendre le calcul.`;
    }
    return `Tickets resto ${monthLabelDe(month)} non recalculés — taux d'époque inconnu. Corrige la ligne ${monthLabelDe(suivant)} à la main si besoin.`;
  }
  return `Remboursement TR non recalculé sur ${skipped.length} mois — taux d'époque inconnu ou mois figé`;
}

function hasTRInItem(item) {
  if (item.isTRRefund) return true;
  if (item.isComposite && Array.isArray(item.components)) return item.components.some(c => c.isTRRefund);
  return false;
}

function hasTRInList(items) {
  return (items || []).some(hasTRInItem);
}

// ============================================================
//  computePortfolioStats — gère 5 types d'opérations
//  - deposit : versement de ta poche → cash++, versé++
//  - purchase : achat d'un support → cash--, invested(support)++
//  - gift : réception gratuite d'un support → coût 0 (marketValue stockée pour
//           l'historique uniquement). Pas d'impact cash/invested.
//  - dividend : cash perçu sur un support → cash++, dividends(support)++
//  - sale : revente d'un support → cash += amount, invested(support) -= costBasis
//
//  Performance :
//    totalGain = (current − invested) + (soldAmount − soldCost) + dividendsRecu
//              = gainLatent          + gainRealized            + dividendes
//  Base du % : totalPurchased (somme cumulée des achats, base stable)
// ============================================================
function computePortfolioStats(data) {
  const { operations, currentValues, etfs } = data;
  // ⚠️ `date` GARDÉE : une opération sans date levait une exception ici
  // (`undefined.localeCompare`), et cette fonction est appelée depuis 7 endroits
  // dont consolidated.js (vue Patrimoine, écran d'accueil) et le snapshot
  // mensuel d'app.js → écran blanc à l'accueil pour UNE ligne mal formée.
  // Repéré par _precompil/tests.js le 29/07/2026. Même motif que savings.js.
  // Les lignes sans date remontent en tête ('' trie avant toute date).
  const sorted = [...operations].sort((a, b) =>
    String(a.date || '').localeCompare(String(b.date || '')) || (a.id - b.id || 0));
  const deposits    = sorted.filter(o => o.type === 'deposit');
  const purchases   = sorted.filter(o => o.type === 'purchase');
  const gifts       = sorted.filter(o => o.type === 'gift');
  const dividends   = sorted.filter(o => o.type === 'dividend');
  const sales       = sorted.filter(o => o.type === 'sale');
  const withdrawals = sorted.filter(o => o.type === 'withdrawal');
  const fees        = sorted.filter(o => o.type === 'fee');

  const totalDeposited = deposits.reduce((s, o) => s + (o.amount || 0), 0);
  const totalWithdrawn = withdrawals.reduce((s, o) => s + (o.amount || 0), 0);
  // Frais de tenue de compte : argent PERDU (≠ retrait récupérable) → il
  // diminue à la fois le cash disponible et la performance globale.
  const totalFees      = fees.reduce((s, o) => s + (o.amount || 0), 0);

  // Agrégation par support
  const purchasedByEtf   = {};
  const soldCostByEtf    = {};
  const soldAmountByEtf  = {};
  const dividendsByEtf   = {};
  etfs.forEach(e => {
    purchasedByEtf[e.id] = 0;
    soldCostByEtf[e.id] = 0;
    soldAmountByEtf[e.id] = 0;
    dividendsByEtf[e.id] = 0;
  });
  purchases.forEach(p => { purchasedByEtf[p.etf] = (purchasedByEtf[p.etf] || 0) + (p.amount || 0); });
  sales.forEach(s => {
    soldCostByEtf[s.etf]   = (soldCostByEtf[s.etf]   || 0) + (s.costBasis || 0);
    soldAmountByEtf[s.etf] = (soldAmountByEtf[s.etf] || 0) + (s.amount    || 0);
  });
  dividends.forEach(d => { dividendsByEtf[d.etf] = (dividendsByEtf[d.etf] || 0) + (d.amount || 0); });

  const totalPurchased  = Object.values(purchasedByEtf).reduce((s, v) => s + v, 0);
  const totalSoldCost   = Object.values(soldCostByEtf).reduce((s, v) => s + v, 0);
  const totalSoldAmount = Object.values(soldAmountByEtf).reduce((s, v) => s + v, 0);
  const totalDividends  = Object.values(dividendsByEtf).reduce((s, v) => s + v, 0);

  // Positions actives au coût d'acquisition
  const totalInvested = totalPurchased - totalSoldCost;
  // Cash dispo = entrées (versé + dividendes + ventes) − sorties (achats + retraits)
  // NB : les frais NE sont PAS déduits ici. La valorisation des supports est
  // saisie manuellement et déjà NETTE de frais (la banque prélève les frais
  // sur le fonds). Les déduire en plus double-compterait : ils sont donc
  // purement informatifs (cf. totalFees, conservé pour l'historique).
  const cashRemaining = totalDeposited + totalDividends + totalSoldAmount - totalPurchased - totalWithdrawn;
  // Valeur actuelle des supports (saisie manuelle, nette de frais)
  const totalCurrent = etfs.reduce((s, e) => s + (currentValues[e.id] || 0), 0);
  // Performance : les frais sont déjà reflétés dans la valorisation nette,
  // donc on ne les soustrait pas une seconde fois du gain.
  const gainLatent   = totalCurrent - totalInvested;
  const gainRealized = totalSoldAmount - totalSoldCost;
  const totalGain    = gainLatent + gainRealized + totalDividends;
  // Base de référence pour le % : achats cumulés (jamais ne diminue)
  const totalGainPct = totalPurchased > 0 ? (totalGain / totalPurchased) * 100 : 0;
  const totalValue   = totalCurrent + cashRemaining;

  // Positions par support
  const positions = etfs.map(e => {
    const kind = e.kind || 'capitalizing';
    const purchased = purchasedByEtf[e.id] || 0;
    const soldCost  = soldCostByEtf[e.id] || 0;
    const soldAmount = soldAmountByEtf[e.id] || 0;
    const dividendsReceived = dividendsByEtf[e.id] || 0;
    const invested = purchased - soldCost;
    const current  = currentValues[e.id] || 0;
    const gainCapital = current - invested;
    const gainRealizedPos = soldAmount - soldCost;
    const gainTotal = gainCapital + gainRealizedPos + dividendsReceived;
    const gainPct = purchased > 0 ? (gainTotal / purchased) * 100 : 0;
    const weight  = totalCurrent > 0 ? (current / totalCurrent) * 100 : 0;
    // Détail des dividendes (pour la mini-liste sous le support distribuant)
    const dividendsList = dividends.filter(d => d.etf === e.id);
    return {
      ...e, kind,
      invested, purchased, current,
      dividendsReceived, dividendsList,
      gain: gainTotal, gainCapital, gainRealized: gainRealizedPos,
      gainPct, weight
    };
  });

  // Affichage conditionnel de la carte / colonne Dividendes
  const hasDistributing = etfs.some(e => (e.kind || 'capitalizing') === 'distributing') || totalDividends > 0;

  // Timelines (inchangées)
  let cumulD = 0;
  const depositsTimeline = deposits.map(d => { cumulD += d.amount; return { date: fmtDate(d.date), amount: d.amount, cumul: cumulD }; });
  const datesPurchases = [...new Set(purchases.map(p => p.date))].sort();
  const investmentTimeline = datesPurchases.map(date => {
    const obj = { date: fmtDate(date) };
    etfs.forEach(e => { obj[e.id] = 0; });
    purchases.filter(p => p.date === date).forEach(p => { obj[p.etf] = (obj[p.etf] || 0) + p.amount; });
    return obj;
  });
  const cumul = {}; etfs.forEach(e => { cumul[e.id] = 0; });
  const cumulByEtf = investmentTimeline.map(row => {
    const obj = { date: row.date };
    etfs.forEach(e => { cumul[e.id] += row[e.id] || 0; obj[e.id] = +cumul[e.id].toFixed(2); });
    return obj;
  });

  return {
    totalDeposited, totalWithdrawn, totalInvested, totalPurchased,
    totalCurrent, totalValue,
    totalGain, totalGainPct, gainLatent, gainRealized,
    totalDividends, totalSoldAmount, totalSoldCost, totalFees,
    cashRemaining, hasDistributing,
    positions, depositsTimeline, investmentTimeline, cumulByEtf,
    sortedOperations: sorted
  };
}

function physicalCurrentValue(asset) {
  return (asset.quantity || 0) * (asset.unitCurrentPrice || 0);
}
function physicalInvested(asset) {
  return (asset.quantity || 0) * (asset.unitPurchasePrice || 0);
}

function computeInvestmentsConsolidated(portfolios) {
  const stats = portfolios.map(p => ({
    id: p.id,
    name: p.name,
    ...computePortfolioStats(p.data),
  }));
  const totalDeposited = stats.reduce((s, p) => s + p.totalDeposited, 0);
  const totalWithdrawn = stats.reduce((s, p) => s + (p.totalWithdrawn || 0), 0);
  const totalInvested  = stats.reduce((s, p) => s + p.totalInvested, 0);
  const totalPurchased = stats.reduce((s, p) => s + p.totalPurchased, 0);
  const totalCurrent   = stats.reduce((s, p) => s + p.totalCurrent, 0);
  const totalDividends = stats.reduce((s, p) => s + (p.totalDividends || 0), 0);
  const totalSoldAmount = stats.reduce((s, p) => s + (p.totalSoldAmount || 0), 0);
  const totalSoldCost   = stats.reduce((s, p) => s + (p.totalSoldCost   || 0), 0);
  const totalFees       = stats.reduce((s, p) => s + (p.totalFees       || 0), 0);
  const cashRemaining = stats.reduce((s, p) => s + p.cashRemaining, 0);
  // Frais informatifs uniquement (déjà nets dans les valorisations) → pas
  // de re-déduction du gain (cf. computePortfolioStats).
  const gainLatent   = totalCurrent - totalInvested;
  const gainRealized = totalSoldAmount - totalSoldCost;
  const totalGain    = gainLatent + gainRealized + totalDividends;
  const totalGainPct = totalPurchased > 0 ? (totalGain / totalPurchased) * 100 : 0;
  // Valeur réelle consolidée des comptes investissement : supports + cash
  const totalValue = totalCurrent + cashRemaining;
  const hasDistributing = stats.some(s => s.hasDistributing);
  const etfsAgg = {};
  stats.forEach(s => {
    s.positions.forEach(pos => {
      if (!etfsAgg[pos.id]) etfsAgg[pos.id] = { id: pos.id, ticker: pos.ticker, label: pos.label, color: pos.color, invested: 0, current: 0 };
      etfsAgg[pos.id].invested += pos.invested;
      etfsAgg[pos.id].current += pos.current;
    });
  });
  const aggPositions = Object.values(etfsAgg).map(e => ({
    ...e,
    gain: e.current - e.invested,
    gainPct: e.invested > 0 ? ((e.current - e.invested) / e.invested) * 100 : 0,
    weight: totalCurrent > 0 ? (e.current / totalCurrent) * 100 : 0,
  })).filter(e => e.current > 0 || e.invested > 0);
  const portfolioBreakdown = stats.map(s => ({
    id: s.id, name: s.name, current: s.totalCurrent, invested: s.totalInvested,
    gain: s.totalGain, gainPct: s.totalGainPct,
    // Le poids du portefeuille dans le total est calculé sur totalValue
    // (cash inclus) pour rester cohérent avec la valeur affichée du portefeuille.
    weight: totalValue > 0 ? ((s.totalValue || s.totalCurrent) / totalValue) * 100 : 0,
  }));
  return {
    totalDeposited, totalWithdrawn, totalInvested, totalPurchased,
    totalCurrent, totalValue,
    totalGain, totalGainPct, gainLatent, gainRealized,
    totalDividends, totalSoldAmount, totalSoldCost, totalFees,
    cashRemaining, hasDistributing,
    aggPositions, portfolioBreakdown
  };
}

// ============================================================
//  MISE À JOUR GROUPÉE DES VALORISATIONS — quelles enveloppes ont
//  RÉELLEMENT changé, et avec quelles valeurs.
// ============================================================
// Pourquoi une fonction PURE, et pas une condition dans la vue : elle décide
// d'une ÉCRITURE. Le harnais de `_precompil/` ne rend pas React, donc une
// condition laissée dans un composant est hors couverture — on l'a mesuré le
// 05/08/2026 sur `rubriqueRouge` : la neutraliser laissait la suite verte.
//
// Ce qu'elle protège : « seules les enveloppes MODIFIÉES sont écrites, et
// seules leurs dates sont rafraîchies ». Sans cette règle, ouvrir la fenêtre
// et valider à vide marquerait TOUTES les enveloppes « à jour d'aujourd'hui »
// et la carte « À rafraîchir » deviendrait fausse — un signal qu'on peut
// éteindre sans rien faire cesse d'être un signal.
//
//   portefeuilles : [{ id, data: { etfs: [{ id }], currentValues } }]
//   saisie        : { [portefeuilleId]: { [etfId]: valeur } }
//                   valeur peut être une chaîne (champ de formulaire).
//
// Renvoie [{ id, currentValues }] pour les SEULES enveloppes modifiées, dans
// l'ordre reçu. `currentValues` est la map COMPLÈTE à écrire : les supports
// non touchés y gardent leur valeur, sinon l'écriture les effacerait.
function enveloppesModifiees(portefeuilles, saisie) {
  const entree = saisie || {};
  const resultat = [];
  (portefeuilles || []).forEach((p) => {
    const actuelles = (p.data && p.data.currentValues) || {};
    const champs = entree[p.id] || {};
    const fusion = { ...actuelles };
    let change = false;
    ((p.data && p.data.etfs) || []).forEach((etf) => {
      const brut = champs[etf.id];
      const valeur = valeurSaisie(brut);
      // Champ vide ou illisible = « valeur inchangée ». C'est la règle
      // d'UpdateValuesForm depuis toujours : on la conserve, on ne l'invente pas.
      if (valeur === null) return;
      const avant = Number(actuelles[etf.id]);
      // Comparaison AU CENTIME : r2 des deux côtés. Sans ça, 12940 relu depuis
      // un champ texte peut différer de 12940 par un epsilon flottant et faire
      // écrire une enveloppe que personne n'a touchée.
      if (!Number.isFinite(avant) || r2(avant) !== r2(valeur)) {
        fusion[etf.id] = r2(valeur);
        change = true;
      }
    });
    if (change) resultat.push({ id: p.id, currentValues: fusion });
  });
  return resultat;
}

// Lecture d'un champ de montant : renvoie null pour « rien de saisi ».
// ⚠️ 0 est une VALEUR, pas un vide — un support peut légitimement tomber à
// zéro, et le §10 rappelle que ce projet signale les montants nuls, il ne les
// escamote pas.
function valeurSaisie(brut) {
  if (brut === null || brut === undefined) return null;
  const texte = String(brut).trim().replace(',', '.');
  if (texte === '') return null;
  const n = parseFloat(texte);
  return Number.isFinite(n) ? n : null;
}

// Cette opération a-t-elle ajusté la valorisation d'un support à sa CRÉATION ?
// 🔴 Trois types le font (`AddOperationForm.submit`, investments.js) : `purchase`
// (+ montant) et `gift` (+ marketValue) la montent, `sale` la baisse — et AUCUN
// des chemins de suppression ne le défait. La valorisation reste donc gonflée du
// montant de l'opération supprimée, et RIEN ne le signale : `currentValuesDate`
// n'étant pas touché, la carte « À rafraîchir » n'a aucune raison de s'allumer.
// Mesuré au navigateur le 11/08/2026 : `currentValues.RNO` resté à 132,50 € au
// lieu de 90,00 € après un achat de 42,50 € créé puis supprimé.
// ⚠️ ON NE RECALCULE PAS, et c'est une décision — 11/08/2026, quatre voies
// écartées et tracées dans BACKLOG.md. Aucun recalcul ne peut être exact : la
// date d'une opération est DÉCLARATIVE, il n'existe aucune date d'enregistrement,
// et `currentValuesDate` vaut pour l'enveloppe ENTIÈRE, pas par support — on ne
// peut donc jamais savoir si CE support a été revalorisé depuis. On prévient, et
// le défaut se répare de lui-même à la prochaine « Mise à jour des valeurs ».
// ⚠️ Cette condition vit ICI et pas dans la vue, bien qu'elle ne décide que d'un
// message : dans un composant elle serait hors couverture du harnais, qui ne rend
// rien. C'est la leçon de `rubriqueRouge` (§10).
function ajusteLaValorisation(type) {
  return type === 'purchase' || type === 'gift' || type === 'sale';
}

// ============================================================
//  CALCULER UN VERSEMENT — plan d'achat par cibles (spec §2.3)
//
//  Fonction PURE, aucune I/O : combien de parts de chaque support acheter
//  pour approcher au mieux les cibles de répartition, avec un versement donné.
//
//  🔴 L'ARRONDI EST AU PLUS PROCHE, JAMAIS TRONQUÉ. Mesuré par force brute
//  dans la spec : avec un besoin de 150 € et une part à 93 €, `floor` achète
//  1 part au lieu de 2, laisse 57 € de retard sur ce support puis déverse le
//  reliquat sur les parts bon marché — écart total 117 € là où l'optimum est
//  à 73 €. Un `Math.floor` posé ici « pour ne pas dépasser » coûte 44 € de
//  dérive sans rien casser en apparence : c'est exactement le genre d'erreur
//  qu'aucun écran ne montre. Les tests la verrouillent.
//
//  🔴 L'ORDRE EST LE PRIX DÉCROISSANT, et c'est le cœur de la méthode. En
//  commençant par le moins cher, on consomme le versement en petites parts et
//  il ne reste plus de quoi acheter une part du support le plus cher, qui
//  décroche alors de sa cible. Égalité de prix → tri par `id`, pour que
//  l'affichage ne saute pas d'un rendu à l'autre.
//
//  🔴 LE REPORT EST SIGNÉ et n'est PAS plafonné à zéro : négatif quand une
//  étape a dépassé son budget (arrondi au-dessus, ou choix manuel), il
//  continue de descendre la cascade et le dernier support absorbe l'écart.
//
//  ⚠️ « Utiliser tout le versement » ne veut PAS dire « reste à zéro » : la
//  règle est qu'il ne reste plus de quoi acheter la moindre part (`complete`).
//  Viser 0 € pile dégrade le résultat — mesuré : +6 parts inutiles et l'écart
//  total qui passe de 11 € à 72 €.
//
//  ⚠️ L'assiette inclut le CASH qui dort déjà dans l'enveloppe : le plan peut
//  donc dépenser plus que le versement lui-même. Voulu.
// ============================================================
// Choix des quantités : la cascade gloutonne SEULE se trompe, et ça se mesure.
// 🔴 POURQUOI CETTE RECHERCHE EXISTE (12/08/2026, relevé par l'utilisateur sur
// ses vraies données). La cascade arrondit au plus proche À CHAQUE ÉTAPE, pour
// elle-même, sans regarder ce que ça coûte en aval. Cas vécu : PAEEM avait un
// budget de 302,75 € pour une part à 35,56 €, soit 8,514 parts. L'arrondi
// donnait 9 — une décision jouée à 0,014 part, environ 50 centimes. Or monter à
// 9 dépense 17,29 € de plus que le budget, et ces 17,29 € sont pris à WPEA, qui
// était déjà sous sa cible. UN EURO MAL PLACÉ COÛTE DEUX FOIS : il fait dépasser
// l'un et affame l'autre. Le report transmet bien l'erreur, mais APRÈS la
// décision : il la constate, il ne l'empêche pas.
// Mesuré sur ce cas : 107,42 € d'écart aux cibles contre 62,20 € pour le plan
// que l'utilisateur a trouvé à la main — et 62,20 € est l'optimum EXACT sous la
// règle « on dépense tout » (vérifié par énumération exhaustive).
//
// ⇒ On garde la cascade, et on explore les DEUX arrondis possibles de chaque
// étape non finale (plancher et plafond de `budget / prix`), la dernière prenant
// toujours tout le reste. On retient la combinaison qui minimise l'écart TOTAL
// aux cibles, en euros — la mesure qu'emploie déjà la spec au §2.4.
// ⚠️ La contrainte « on dépense tout » est respectée PAR CONSTRUCTION, la
// dernière étape prenant le maximum achetable : le reliquat est donc toujours
// inférieur au prix de la part la moins chère. *Sans elle, l'optimum du cas réel
// laissait 19,57 € dormir — près de trois parts — pour gagner 11 € d'écart.*
// ⚠️ L'arrondi naturel est essayé EN PREMIER : si le plafond de feuilles est
// atteint, le résultat ne peut donc jamais être pire que la cascade seule.
// ⚠️ Un support dont la quantité est FORCÉE n'est pas exploré : le choix de
// l'utilisateur ne se discute pas, on optimise seulement autour de lui.
function _choisirQuantites(ordre, besoin, available, totalAfter, over, cibleEffective) {
  const PLAFOND_FEUILLES = 4096; // 2^12 — au-delà, on garde le meilleur trouvé
  let meilleur = null;
  let feuilles = 0;
  const coutDe = (s, q) => {
    const o = over[s.id] || {};
    return (o.cost === null || o.cost === undefined) ? r2(q * (Number(s.price) || 0)) : r2(Number(o.cost) || 0);
  };
  const marcher = (rang, left, carry, qs) => {
    if (feuilles > PLAFOND_FEUILLES) return;
    if (rang === ordre.length) {
      feuilles += 1;
      const ecart = ordre.reduce((a, s, i) => a + Math.abs(
        ((Number(s.value) || 0) + coutDe(s, qs[i])) - totalAfter * cibleEffective(s)), 0);
      if (!meilleur || ecart < meilleur.ecart - 1e-9) meilleur = { qs: qs.slice(), ecart };
      return;
    }
    const s = ordre[rang];
    const prix = Number(s.price) || 0;
    const dernier = rang === ordre.length - 1;
    const budget = besoin[s.id] + carry;
    const maxAchetable = Math.max(0, Math.floor(Math.max(0, left) / prix + 1e-9));
    const o = over[s.id] || {};
    let candidats;
    if (o.qty !== null && o.qty !== undefined) {
      candidats = [Math.min(Math.max(0, Math.floor(Number(o.qty) || 0)), maxAchetable)];
    } else if (dernier) {
      candidats = [maxAchetable];
    } else {
      const ideal = Math.max(0, budget) / prix;
      const naturel = Math.min(Math.max(0, Math.round(ideal)), maxAchetable);
      const autre = naturel === Math.min(Math.max(0, Math.floor(ideal)), maxAchetable)
        ? Math.min(Math.max(0, Math.ceil(ideal)), maxAchetable)
        : Math.min(Math.max(0, Math.floor(ideal)), maxAchetable);
      candidats = naturel === autre ? [naturel] : [naturel, autre];
    }
    candidats.forEach((q) => {
      qs.push(q);
      marcher(rang + 1, r2(left - coutDe(s, q)), budget - coutDe(s, q), qs);
      qs.pop();
    });
  };
  marcher(0, available, 0, []);
  return meilleur ? meilleur.qs : ordre.map(() => 0);
}

function computeContributionPlan({ amount, cash, supports, overrides } = {}) {
  const liste = Array.isArray(supports) ? supports : [];
  const over = overrides || {};
  const available = r2(Math.max(0, Number(amount) || 0) + Math.max(0, Number(cash) || 0));

  // Périmètre : une cible ET un prix. Un exclu n'apparaît dans aucune étape,
  // mais il est RENDU avec sa raison — un support qui disparaît sans un mot
  // fait douter du plan entier.
  const dansLePerimetre = [];
  const excluded = [];
  liste.forEach((s) => {
    const prix = Number(s.price) || 0;
    if (s.target === null || s.target === undefined) excluded.push({ id: s.id, reason: 'no-target' });
    else if (prix <= 0) excluded.push({ id: s.id, reason: 'no-price' });
    else dansLePerimetre.push(s);
  });

  // T = le portefeuille APRÈS investissement de l'assiette. C'est ce qui permet
  // au versement de corriger une dérive : la cible s'applique au total final,
  // pas au total actuel. ⚠️ Les supports HORS périmètre comptent quand même
  // dans T — ils font partie du portefeuille, seulement on ne les alimente pas.
  const totalAfter = liste.reduce((a, s) => a + (Number(s.value) || 0), 0) + available;

  // 🔴 LES CIBLES SONT NORMALISÉES SUR LEUR PROPRE SOMME, et non sur 100 —
  // arbitrage de l'utilisateur du 12/08/2026. Des cibles à 40/40 se comportent
  // donc comme 50/50.
  // Avant : `besoin = T × cible / 100`. Si les cibles ne totalisaient pas 100 %,
  // la part orpheline n'était attribuée à personne — et comme le dernier support
  // prend tout le reliquat, elle partait ENTIÈREMENT sur le moins cher. Ce n'était
  // donc pas « on répartit au prorata », c'était un déversement, et il fallait un
  // avertissement à l'écran pour le dire.
  // ⚠️ Somme nulle (aucune cible, ou toutes à 0) : on ne divise pas par zéro et
  // tous les besoins sont nuls — le dernier support absorbe alors l'assiette,
  // comme avant.
  const sommeCibles = dansLePerimetre.reduce((a, s) => a + (Number(s.target) || 0), 0);
  const besoin = {};
  dansLePerimetre.forEach((s) => {
    const part = sommeCibles > 0 ? (Number(s.target) || 0) / sommeCibles : 0;
    besoin[s.id] = Math.max(0, totalAfter * part - (Number(s.value) || 0));
  });

  const ordre = [...dansLePerimetre].sort(
    (a, b) => (Number(b.price) || 0) - (Number(a.price) || 0) || String(a.id).localeCompare(String(b.id))
  );

  // Les quantités RETENUES (overrides compris) et celles que le calcul
  // PROPOSE (comme s'il n'y avait aucun ajustement) — deux passes, parce que
  // « proposition N » doit dire ce que rend le bouton « Réinitialiser », pas ce
  // que devient la cascade une fois qu'on a forcé une valeur en amont.
  // La cible EFFECTIVE, en fraction : c'est elle que l'écart mesure, sinon
  // l'affichage se contredirait (on lirait « cible 40 % » et « → 50 % »).
  const cibleEffective = (s) => (sommeCibles > 0 ? (Number(s.target) || 0) / sommeCibles : 0);
  const retenues = _choisirQuantites(ordre, besoin, available, totalAfter, over, cibleEffective);
  const proposees = Object.keys(over).length
    ? _choisirQuantites(ordre, besoin, available, totalAfter, {}, cibleEffective)
    : retenues;

  const steps = [];
  let left = available;
  let carry = 0;
  ordre.forEach((s, rang) => {
    const prix = Number(s.price) || 0;
    const valeur = Number(s.value) || 0;
    const isLast = rang === ordre.length - 1;
    const carryIn = carry;
    const budget = besoin[s.id] + carryIn;
    // ⚠️ Le +1e-9 absorbe l'erreur binaire : sans lui, 1200/6 peut valoir
    // 199.99999999999997 et `floor` rend 199 parts au lieu de 200.
    const maxAchetable = Math.max(0, Math.floor(Math.max(0, left) / prix + 1e-9));
    // ⚠️ `suggested` vient de la passe SANS override, `qty` de la passe avec —
    // les deux sont déjà replafonnées par ce qui reste (un override survit à un
    // changement de versement, mais ne peut pas faire acheter ce qu'on n'a pas).
    const suggested = Math.min(proposees[rang], isLast ? maxAchetable : proposees[rang]);
    const o = over[s.id] || {};
    const qty = retenues[rang];
    const costAuto = r2(qty * prix);
    // ⚠️ Le montant forcé n'est JAMAIS plafonné — le brider falsifierait une
    // saisie qui décrit ce que le courtier a réellement débité. Le dépassement
    // se SIGNALE (l'assiette passe en négatif), il ne se corrige pas.
    const cost = o.cost === null || o.cost === undefined ? costAuto : r2(Number(o.cost) || 0);
    const valueAfter = r2(valeur + cost);

    left = r2(left - cost);
    carry = budget - cost;

    steps.push({
      id: s.id, price: prix, target: r2(cibleEffective(s) * 100),
      need: r2(besoin[s.id]), carryIn: r2(carryIn), budget: r2(budget),
      qty, suggested, qtyAdjusted: qty !== suggested,
      cost, costAuto, costForced: cost !== costAuto,
      carryOut: r2(carry), leftAfter: left,
      valueAfter, pctAfter: totalAfter ? r2(valueAfter / totalAfter * 100) : 0,
      gapPts: totalAfter ? r2(valueAfter / totalAfter * 100 - cibleEffective(s) * 100) : 0,
      isLast,
    });
  });

  const prixMini = ordre.reduce((m, s) => Math.min(m, Number(s.price) || 0), Infinity);
  return {
    steps, excluded, available, totalAfter,
    invested: r2(available - left),
    left,
    targetSum: r2(dansLePerimetre.reduce((a, s) => a + (Number(s.target) || 0), 0)),
    // « Plus rien n'est achetable » — et non « le reste vaut zéro ».
    complete: ordre.length > 0 && left < prixMini,
  };
}
