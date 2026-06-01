/* ===================================================================
   Données d'exemple — terminologies SMT
   Arbres bruts (code / libellé / type / synonymes / notes / enfants).
   Le modèle nested set (lft, rgt, depth, path) est calculé au chargement
   par buildNestedSet() dans app.js — exactement comme dans smt2parquet.
   =================================================================== */

const TERMINOLOGIES = {
  cim10: {
    name: "CIM-10",
    longName: "Classification statistique internationale des maladies — 10ᵉ révision",
    meta: {
      terminology: "cim10",
      version: "2025-01-01",
      source_file: "terminologie-cim-10-2025-01-01.rdf",
      generated_at: "2026-05-11T09:42:18Z",
    },
    types: {
      chapter: "Chapitre",
      block: "Bloc",
      category: "Catégorie",
      subcategory: "Sous-catégorie",
    },
    tree: [
      {
        c: "I", l: "Certaines maladies infectieuses et parasitaires", t: "chapter",
        inc: "Maladies généralement reconnues comme transmissibles ou à transmission possible.",
        exc: "Porteur ou porteur présumé d'une maladie infectieuse (Z22.-)",
        ch: [
          {
            c: "A00-A09", l: "Maladies intestinales infectieuses", t: "block",
            ch: [
              {
                c: "A00", l: "Choléra", t: "category",
                syn: ["Cholera asiatique", "Infection à Vibrio cholerae"],
                ch: [
                  { c: "A00.0", l: "Choléra à Vibrio cholerae 01, biovar cholerae", t: "subcategory" },
                  { c: "A00.1", l: "Choléra à Vibrio cholerae 01, biovar eltor", t: "subcategory" },
                  { c: "A00.9", l: "Choléra, sans précision", t: "subcategory" },
                ],
              },
              {
                c: "A01", l: "Fièvres typhoïde et paratyphoïde", t: "category",
                syn: ["Fièvre entérique"],
                ch: [
                  { c: "A01.0", l: "Fièvre typhoïde", t: "subcategory", syn: ["Infection à Salmonella typhi"] },
                  { c: "A01.1", l: "Fièvre paratyphoïde A", t: "subcategory" },
                  { c: "A01.4", l: "Fièvre paratyphoïde, sans précision", t: "subcategory" },
                ],
              },
              { c: "A02", l: "Autres infections à Salmonella", t: "category", syn: ["Salmonellose"] },
              { c: "A03", l: "Shigellose", t: "category", syn: ["Dysenterie bacillaire"] },
              {
                c: "A04", l: "Autres infections intestinales bactériennes", t: "category",
                exc: "Intoxication alimentaire bactérienne (A05.-)",
              },
              {
                c: "A09", l: "Diarrhée et gastro-entérite d'origine présumée infectieuse", t: "category",
                syn: ["Colite infectieuse", "Entérite infectieuse", "Gastro-entérite SAI"],
                inc: "Diarrhée présumée d'origine infectieuse.",
              },
            ],
          },
          {
            c: "A15-A19", l: "Tuberculose", t: "block",
            inc: "Infections dues à Mycobacterium tuberculosis et Mycobacterium bovis.",
            ch: [
              { c: "A15", l: "Tuberculose respiratoire, confirmée bactériologiquement et histologiquement", t: "category" },
              { c: "A16", l: "Tuberculose respiratoire, non confirmée", t: "category" },
              { c: "A17", l: "Tuberculose du système nerveux", t: "category" },
              { c: "A18", l: "Tuberculose d'autres organes", t: "category" },
              { c: "A19", l: "Tuberculose miliaire", t: "category", syn: ["Tuberculose disséminée", "Polysérite tuberculeuse"] },
            ],
          },
          {
            c: "B20-B24", l: "Maladie due au virus de l'immunodéficience humaine (VIH)", t: "block",
            ch: [
              { c: "B20", l: "Maladie due au VIH, à l'origine d'infections et de maladies parasitaires", t: "category", syn: ["SIDA avec infection"] },
              { c: "B22", l: "Maladie due au VIH, à l'origine d'autres maladies précisées", t: "category" },
              { c: "B24", l: "Maladie due au VIH, sans précision", t: "category", syn: ["SIDA SAI", "Syndrome d'immunodéficience acquise SAI"] },
            ],
          },
        ],
      },
      {
        c: "II", l: "Tumeurs", t: "chapter",
        inc: "Tumeurs malignes, in situ, bénignes et de comportement incertain.",
        ch: [
          {
            c: "C00-C14", l: "Tumeurs malignes des lèvres, de la cavité buccale et du pharynx", t: "block",
            ch: [
              { c: "C00", l: "Tumeur maligne de la lèvre", t: "category" },
              { c: "C01", l: "Tumeur maligne de la base de la langue", t: "category" },
              { c: "C02", l: "Tumeur maligne d'autres parties de la langue, non précisées", t: "category" },
            ],
          },
          {
            c: "C15-C26", l: "Tumeurs malignes des organes digestifs", t: "block",
            ch: [
              { c: "C15", l: "Tumeur maligne de l'œsophage", t: "category" },
              {
                c: "C16", l: "Tumeur maligne de l'estomac", t: "category",
                syn: ["Cancer gastrique", "Cancer de l'estomac"],
                ch: [
                  { c: "C16.0", l: "Cardia", t: "subcategory", syn: ["Jonction œsogastrique"] },
                  { c: "C16.1", l: "Fundus de l'estomac", t: "subcategory" },
                  { c: "C16.2", l: "Corps de l'estomac", t: "subcategory" },
                  { c: "C16.9", l: "Estomac, sans précision", t: "subcategory" },
                ],
              },
              { c: "C18", l: "Tumeur maligne du côlon", t: "category", syn: ["Cancer colique"] },
              { c: "C20", l: "Tumeur maligne du rectum", t: "category", syn: ["Cancer rectal"] },
              { c: "C22", l: "Tumeur maligne du foie et des voies biliaires intrahépatiques", t: "category" },
            ],
          },
          {
            c: "C50-C50", l: "Tumeur maligne du sein", t: "block",
            ch: [
              {
                c: "C50", l: "Tumeur maligne du sein", t: "category",
                syn: ["Cancer du sein", "Carcinome mammaire"],
                ch: [
                  { c: "C50.1", l: "Partie centrale du sein", t: "subcategory" },
                  { c: "C50.4", l: "Quadrant supéro-externe du sein", t: "subcategory" },
                  { c: "C50.9", l: "Sein, sans précision", t: "subcategory" },
                ],
              },
            ],
          },
        ],
      },
      {
        c: "V", l: "Troubles mentaux et du comportement", t: "chapter",
        ch: [
          {
            c: "F30-F39", l: "Troubles de l'humeur [affectifs]", t: "block",
            ch: [
              { c: "F31", l: "Trouble affectif bipolaire", t: "category", syn: ["Psychose maniaco-dépressive", "Maladie bipolaire"] },
              {
                c: "F32", l: "Épisodes dépressifs", t: "category",
                syn: ["Dépression", "Épisode dépressif isolé"],
                inc: "Premier épisode de réaction dépressive ou de dépression.",
                ch: [
                  { c: "F32.0", l: "Épisode dépressif léger", t: "subcategory" },
                  { c: "F32.1", l: "Épisode dépressif moyen", t: "subcategory" },
                  { c: "F32.2", l: "Épisode dépressif sévère sans symptômes psychotiques", t: "subcategory" },
                ],
              },
            ],
          },
          {
            c: "F40-F48", l: "Troubles névrotiques, troubles liés à des facteurs de stress", t: "block",
            ch: [
              { c: "F41", l: "Autres troubles anxieux", t: "category", syn: ["Anxiété", "Trouble panique"] },
              { c: "F43", l: "Réaction à un facteur de stress sévère, et troubles de l'adaptation", t: "category", syn: ["État de stress post-traumatique"] },
            ],
          },
        ],
      },
      {
        c: "IX", l: "Maladies de l'appareil circulatoire", t: "chapter",
        exc: "Certaines affections périnatales (P00-P96)",
        ch: [
          {
            c: "I10-I16", l: "Maladies hypertensives", t: "block",
            ch: [
              { c: "I10", l: "Hypertension essentielle (primitive)", t: "category", syn: ["HTA essentielle", "Hypertension artérielle"] },
              { c: "I11", l: "Cardiopathie hypertensive", t: "category" },
            ],
          },
          {
            c: "I20-I25", l: "Cardiopathies ischémiques", t: "block",
            ch: [
              { c: "I20", l: "Angine de poitrine", t: "category", syn: ["Angor", "Angine de poitrine de Prinzmetal"] },
              {
                c: "I21", l: "Infarctus aigu du myocarde", t: "category",
                syn: ["IDM", "Crise cardiaque", "Infarctus du myocarde aigu"],
                inc: "Infarctus du myocarde précisé comme aigu ou évoluant depuis 4 semaines (28 jours) ou moins.",
                ch: [
                  { c: "I21.0", l: "Infarctus transmural aigu de la paroi antérieure", t: "subcategory" },
                  { c: "I21.1", l: "Infarctus transmural aigu de la paroi inférieure", t: "subcategory" },
                  { c: "I21.4", l: "Infarctus sous-endocardique aigu", t: "subcategory", syn: ["Infarctus non transmural SAI"] },
                  { c: "I21.9", l: "Infarctus aigu du myocarde, sans précision", t: "subcategory" },
                ],
              },
              { c: "I25", l: "Cardiopathie ischémique chronique", t: "category", syn: ["Maladie coronarienne chronique"] },
            ],
          },
        ],
      },
      {
        c: "X", l: "Maladies de l'appareil respiratoire", t: "chapter",
        ch: [
          {
            c: "J00-J06", l: "Infections aiguës des voies respiratoires supérieures", t: "block",
            ch: [
              { c: "J00", l: "Rhinopharyngite aiguë [rhume banal]", t: "category", syn: ["Rhume", "Coryza aigu", "Nasopharyngite aiguë"] },
              { c: "J02", l: "Pharyngite aiguë", t: "category", syn: ["Mal de gorge aigu"] },
              { c: "J03", l: "Amygdalite aiguë", t: "category", syn: ["Angine"] },
            ],
          },
          {
            c: "J09-J18", l: "Grippe et pneumopathie", t: "block",
            ch: [
              { c: "J10", l: "Grippe, due à d'autres virus grippaux identifiés", t: "category", syn: ["Influenza"] },
              {
                c: "J18", l: "Pneumopathie, micro-organisme non précisé", t: "category",
                syn: ["Pneumonie SAI", "Bronchopneumonie SAI"],
                ch: [
                  { c: "J18.0", l: "Bronchopneumonie, sans précision", t: "subcategory" },
                  { c: "J18.9", l: "Pneumopathie, sans précision", t: "subcategory" },
                ],
              },
            ],
          },
        ],
      },
      {
        c: "XI", l: "Maladies de l'appareil digestif", t: "chapter",
        ch: [
          {
            c: "K20-K31", l: "Maladies de l'œsophage, de l'estomac et du duodénum", t: "block",
            ch: [
              { c: "K21", l: "Reflux gastro-œsophagien", t: "category", syn: ["RGO", "Œsophagite par reflux"] },
              { c: "K25", l: "Ulcère de l'estomac", t: "category", syn: ["Ulcère gastrique"] },
              { c: "K29", l: "Gastrite et duodénite", t: "category" },
            ],
          },
          {
            c: "K35-K38", l: "Maladies de l'appendice", t: "block",
            ch: [
              { c: "K35", l: "Appendicite aiguë", t: "category", syn: ["Appendicite"] },
              { c: "K37", l: "Appendicite, sans précision", t: "category" },
            ],
          },
        ],
      },
    ],
  },

  ccam: {
    name: "CCAM",
    longName: "Classification commune des actes médicaux",
    meta: {
      terminology: "ccam",
      version: "v82.00",
      source_file: "terminologie-ccam-v82.00.rdf",
      generated_at: "2026-05-11T09:51:04Z",
    },
    types: {
      chapter: "Chapitre",
      subchapter: "Sous-chapitre",
      paragraph: "Paragraphe",
      acte: "Acte",
    },
    tree: [
      {
        c: "01", l: "Système nerveux central, périphérique et autonome", t: "chapter",
        ch: [
          {
            c: "01.01", l: "Actes diagnostiques sur le système nerveux", t: "subchapter",
            ch: [
              { c: "AAQP002", l: "Électroencéphalographie de longue durée (≥ 24 heures)", t: "acte", topo: "Encéphale" },
              { c: "AALB001", l: "Ponction lombaire à visée diagnostique", t: "acte", topo: "Espace sous-arachnoïdien lombaire" },
            ],
          },
          {
            c: "01.02", l: "Actes thérapeutiques sur le système nerveux", t: "subchapter",
            ch: [
              { c: "AAFA001", l: "Évacuation d'un hématome intracrânien, par craniotomie", t: "acte", topo: "Encéphale" },
              { c: "AHPA009", l: "Neurostimulation médullaire, par voie transcutanée", t: "acte", topo: "Moelle épinière" },
            ],
          },
        ],
      },
      {
        c: "04", l: "Appareil circulatoire", t: "chapter",
        ch: [
          {
            c: "04.02", l: "Actes thérapeutiques sur les vaisseaux", t: "subchapter",
            ch: [
              { c: "DGAF001", l: "Pontage aortocoronarien, par thoracotomie avec CEC", t: "acte", topo: "Artère coronaire", mode: "Voie ouverte" },
              { c: "DDAF001", l: "Angioplastie d'une artère coronaire, par voie endovasculaire", t: "acte", topo: "Artère coronaire", mode: "Voie endovasculaire" },
              { c: "EQQM001", l: "Mesure de la pression artérielle des 24 heures [MAPA]", t: "acte", topo: "Artère" },
            ],
          },
          {
            c: "04.05", l: "Actes diagnostiques sur le cœur", t: "subchapter",
            ch: [
              { c: "DZQM006", l: "Échocardiographie transthoracique", t: "acte", topo: "Cœur" },
              { c: "DEQP003", l: "Électrocardiographie sur au moins 12 dérivations", t: "acte", topo: "Cœur" },
            ],
          },
        ],
      },
      {
        c: "07", l: "Appareil digestif", t: "chapter",
        ch: [
          {
            c: "07.01", l: "Actes diagnostiques sur le tube digestif", t: "subchapter",
            ch: [
              { c: "HEQE002", l: "Endoscopie œsogastroduodénale", t: "acte", topo: "Tube digestif haut" },
              { c: "HHQE005", l: "Coloscopie totale", t: "acte", topo: "Côlon" },
            ],
          },
        ],
      },
    ],
  },
};
