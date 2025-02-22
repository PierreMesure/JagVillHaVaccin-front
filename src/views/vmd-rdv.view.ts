import {css, customElement, html, LitElement, internalProperty, property, PropertyValues, query,
    unsafeCSS
} from 'lit-element';
import {repeat} from "lit-html/directives/repeat";
import {styleMap} from "lit-html/directives/style-map";
import {Router} from "../routing/Router";
import rdvViewCss from "./vmd-rdv.view.scss";
import distanceEntreDeuxPoints from "../distance"
import {
    SearchRequest,
    CodeDepartement,
    CodeTriCentre,
    Commune,
    libelleUrlPathDeCommune,
    libelleUrlPathDuDepartement,
    Lieu, LieuAffichableAvecDistance, LieuxAvecDistanceParDepartement,
    LieuxParDepartement, SearchType,
    State,
    TRIS_CENTRE
} from "../state/State";
import { formatDistanceToNow, parseISO } from 'date-fns'
import { sv } from 'date-fns/locale'
import {Strings} from "../utils/Strings";
import {
    ValueStrCustomEvent,
} from "../components/vmd-commune-or-departement-selector.component";
import {DEPARTEMENTS_LIMITROPHES} from "../utils/Departements";
import {TemplateResult} from "lit-html";
import {Analytics} from "../utils/Analytics";
import {LieuCliqueCustomEvent} from "../components/vmd-appointment-card.component";
import {setDebouncedInterval, delay } from "../utils/Schedulers";
import {ArrayBuilder} from "../utils/Arrays";
import {classMap} from "lit-html/directives/class-map";
import {CSS_Global} from "../styles/ConstructibleStyleSheets";
import tippy from 'tippy.js';

const MAX_DISTANCE_CENTRE_IN_KM = 100;
// aimed at fixing nasty Safari rendering bug
const MAX_CENTER_RESULTS_COUNT = 180;

export abstract class AbstractVmdRdvView extends LitElement {
    DELAI_VERIFICATION_MISE_A_JOUR = 45000

    //language=css
    static styles = [
        CSS_Global,
        css`${unsafeCSS(rdvViewCss)}`,
        css`
        `
    ];

    @property({type: Array, attribute: false}) lieuxParDepartementAffiches: LieuxAvecDistanceParDepartement | undefined = undefined;
    @property({type: Boolean, attribute: false}) searchInProgress: boolean = false;
    @property({type: Boolean, attribute: false}) miseAJourDisponible: boolean = false;
    @internalProperty() protected currentSearch: SearchRequest | void = undefined

    @query("#chronodose-label") $chronodoseLabel!: HTMLSpanElement;

    protected derniereCommuneSelectionnee: Commune|undefined = undefined;
    protected lieuBackgroundRefreshIntervalId: ReturnType<typeof setTimeout>|undefined = undefined;

    get totalCreneaux() {
        if (!this.lieuxParDepartementAffiches) {
            return 0;
        }
        return this.lieuxParDepartementAffiches
            .lieuxAffichables
            .reduce((total, lieu) => total+lieu.appointment_count, 0);
    }

    protected beforeNewSearchFromLocation (search: SearchRequest): SearchRequest {
      return search
    }

    async onSearchSelected (event: CustomEvent<SearchRequest>) {
      const search = event.detail
      this.goToNewSearch(this.beforeNewSearchFromLocation(search))
    }

    protected async goToNewSearch (search: SearchRequest) {
      if (SearchRequest.isByDepartement(search)) {
        Router.navigateToRendezVousAvecDepartement(search.departement.code_departement, libelleUrlPathDuDepartement(search.departement), search.type);
      } else {
        const departements = await State.current.departementsDisponibles()
        const departement = departements.find(d => d.code_departement === search.commune.codeDepartement);
        const commune = search.commune
        Router.navigateToRendezVousAvecCommune(search.tri, commune.codeDepartement,
          libelleUrlPathDuDepartement(departement!), commune.code, commune.codePostal, libelleUrlPathDeCommune(commune), search.type)
      }
    }

    render() {
        const lieuxDisponibles = (this.lieuxParDepartementAffiches && this.lieuxParDepartementAffiches.lieuxAffichables)?
            this.lieuxParDepartementAffiches.lieuxAffichables.filter(l => {
                if(this.currentSearch && SearchRequest.isChronodoseType(this.currentSearch)) {
                    return l.appointment_count > 0;
                } else /* if(this.currentSearch && SearchRequest.isStandardType(this.currentSearch)) */ {
                    return l.disponible;
                }
            }):[];

        return html`
            <div class="criteria-container text-dark rounded-3 pb-3 ${classMap({'bg-std': SearchRequest.isStandardType(this.currentSearch), 'bg-chronodose': SearchRequest.isChronodoseType(this.currentSearch)})}">
              <ul class="p-0 d-flex flex-row mb-5 bg-white fs-5">
                <li class="col bg-std text-std tab ${classMap({selected: SearchRequest.isStandardType(this.currentSearch)})}" @click="${() => this.updateSearchTypeTo('standard')}">
                  Alla tider
                </li>
              </ul>
              <div class="rdvForm-fields row align-items-center mb-3 mb-md-5">
                    <vmd-search
                          .value="${this.currentSearch}"
                          @on-search="${this.onSearchSelected}"
                        />
                </div>
                ${this.renderAdditionnalSearchCriteria()}
            </div>

            <div class="spacer mt-5 mb-5"></div>

            ${this.searchInProgress?html`
              <div class="d-flex justify-content-center">
                <div class="spinner-border text-primary" style="height: 50px; width: 50px" role="status">
                </div>
              </div>
            `:html`
                <h3 class="fw-normal text-center h4 ${classMap({ 'search-chronodose': SearchRequest.isChronodoseType(this.currentSearch), 'search-standard': SearchRequest.isStandardType(this.currentSearch) })}"
                    style="${styleMap({display: (this.lieuxParDepartementAffiches) ? 'block' : 'none'})}">
                    ${SearchRequest.isChronodoseType(this.currentSearch)
                        ? `${this.totalCreneaux.toLocaleString()} lediga vaccintid${Strings.plural(this.totalCreneaux, "er")} chronodose${Strings.plural(this.totalCreneaux)} hittade`
                        : `${this.totalCreneaux.toLocaleString()} lediga vaccintid${Strings.plural(this.totalCreneaux, "er")} hittade`
                    }
                  ${this.libelleLieuSelectionne()}
                  <br/>
                  ${(this.lieuxParDepartementAffiches && this.lieuxParDepartementAffiches.derniereMiseAJour) ?
                      html`
                      <p class="fs-6 text-gray-600">
                        Senast uppdaterat för
                        ${ formatDistanceToNow(parseISO(this.lieuxParDepartementAffiches!.derniereMiseAJour), { locale: sv }) }
                        ${this.miseAJourDisponible?html`
                          <button class="btn btn-primary" @click="${() => { this.refreshLieux(); this.miseAJourDisponible = false; this.launchCheckingUpdates() }}">Rafraîchir</button>
                        `:html``}
                      </p>
                      <p class="alert alert-warning fs-6">
                          <i class="bi vmdicon-attention-fill"></i>
                          Idag kan Jag vill ha vaccin bara visa lediga tider från vissa regioner (Blekinge, Jönköping, Kalmar, Kronoberg och Örebro) och vissa mottagningar.
                      </p>
                        `
                        : html``}
                  </h3>

                <div class="spacer mt-5 mb-5"></div>
                <div class="resultats px-2 py-5 text-dark bg-light rounded-3">
                    ${lieuxDisponibles.length ? html`
                        <h2 class="row align-items-center justify-content-center mb-5 h5 px-3">
                            <i class="bi vmdicon-calendar2-check-fill text-success me-2 fs-3 col-auto"></i>
                            <span class="col col-sm-auto">
                                ${lieuxDisponibles.length} vaccinationsmottagning${Strings.plural(lieuxDisponibles.length, 'ar')} med lediga ${SearchRequest.isChronodoseType(this.currentSearch) ? 'chronodoses' : 'tider'}
                            </span>
                        </h2>
                    ` : html`
                        <h2 class="row align-items-center justify-content-center mb-5 h5">
                          <i class="bi vmdicon-calendar-x-fill text-black-50 me-2 fs-3 col-auto"></i>
                          Ingen ${SearchRequest.isChronodoseType(this.currentSearch) ? 'chronodose' : 'vaccintid'} hittad
                        </h2>
                        <div class="mb-5 container-content">
                          <p class="fst-italic">Vi hittade ingen <strong>vaccintid</strong> på Regionens bokningsplattformar. </p>
                          <p class="fst-italic">Jag vill ha vaccin kan inte ännu se tider på alla plattformar och därför finns det bara data från regionerna Blekinge, Jönköping, Kalmar, Kronoberg och Örebro. Vi rekommenderar att kolla manuellt genom att trycka på knappen "Kolla på mottagningssidan".
                            ${SearchRequest.isChronodoseType(this.currentSearch) ? html`
                                    Si vous êtes déjà éligible, vous pouvez <a class="text-decoration-underline" href="${this.getStandardResultsLink()}"">consulter les créneaux classiques</a>.
                            `:``}
                          </p>
                          <p class="fst-italic">Snart kommer vi även släppa ut mobilappar så man kan få push-notiser när nya vaccintider släpps i närheten.
                          </p>
                        </div>
                    `}

                    ${repeat(this.lieuxParDepartementAffiches?this.lieuxParDepartementAffiches.lieuxAffichables:[], (c => `${c.departement}||${c.nom}||${c.plateforme}}`), (lieu, index) => {
                        return html`<vmd-appointment-card
                            style="--list-index: ${index}"
                            .lieu="${lieu}"
                            theme="${(!!this.currentSearch)?this.currentSearch.type:''}"
                            .highlightable="${SearchRequest.isChronodoseType(this.currentSearch)}"
                            @prise-rdv-cliquee="${(event: LieuCliqueCustomEvent) => this.prendreRdv(event.detail.lieu)}"
                            @verification-rdv-cliquee="${(event: LieuCliqueCustomEvent) =>  this.verifierRdv(event.detail.lieu)}"
                        />`;
                    })}
                </div>
                ${SearchRequest.isStandardType(this.currentSearch)?html`
                <div class="eligibility-criteria fade-in-then-fade-out">
                    <p>Kolla noggrant att du ingår i grupperna som kan vaccinera sig i din region innan du bokar en dos.</p>
                </div>`:html``}
            `}
        `;
    }

    updated(changedProperties: PropertyValues) {
        super.updated(changedProperties);
        tippy(this.$chronodoseLabel, {
            content: (el) => el.getAttribute('title')!
        })
    }



    async connectedCallback() {
        super.connectedCallback();
        this.launchCheckingUpdates();
    }

    disconnectedCallback() {
        super.disconnectedCallback();

        this.stopCheckingUpdates();
    }

    stopCheckingUpdates() {
        if(this.lieuBackgroundRefreshIntervalId) {
            clearInterval(this.lieuBackgroundRefreshIntervalId);
            this.lieuBackgroundRefreshIntervalId = undefined;
        }
    }

    launchCheckingUpdates() {
        if(this.lieuBackgroundRefreshIntervalId === undefined) {
            this.lieuBackgroundRefreshIntervalId = setDebouncedInterval(async () => {
                const currentSearch = this.currentSearch
                if (currentSearch) {
                    const codeDepartement = SearchRequest.isByDepartement(currentSearch)
                        ? currentSearch.departement.code_departement
                        : currentSearch.commune.codeDepartement
                    const derniereMiseAJour = this.lieuxParDepartementAffiches?.derniereMiseAJour
                    const lieuxAJourPourDepartement = await State.current.lieuxPour(codeDepartement)
                    this.miseAJourDisponible = (derniereMiseAJour !== lieuxAJourPourDepartement.derniereMiseAJour);

                    // we stop the update check if there has been one
                    if (this.miseAJourDisponible) {
                        this.stopCheckingUpdates();
                    }
                    // Used only to refresh derniereMiseAJour's displayed relative time
                    await this.requestUpdate();
                }
            }, this.DELAI_VERIFICATION_MISE_A_JOUR);
        }
    }

    abstract codeDepartementAdditionnels(codeDepartementSelectionne: CodeDepartement): CodeDepartement[]

    async refreshLieux() {
        const currentSearch = this.currentSearch
        if(currentSearch) {
            // FIXME move all of this to testable file
            const codeDepartement = SearchRequest.isByDepartement(currentSearch)
              ? currentSearch.departement.code_departement
              : currentSearch.commune.codeDepartement
            try {
                this.searchInProgress = true;
                await delay(1) // give some time (one tick) to render loader before doing the heavy lifting
                const [lieuxDepartement, ...lieuxDepartementsLimitrophes] = await Promise.all([
                    State.current.lieuxPour(codeDepartement),
                    ...this.codeDepartementAdditionnels(codeDepartement).map(dept => State.current.lieuxPour(dept))
                ]);

                const lieuxParDepartement = [lieuxDepartement].concat(lieuxDepartementsLimitrophes).reduce((mergedLieuxParDepartement, lieuxParDepartement) => ({
                    codeDepartements: mergedLieuxParDepartement.codeDepartements.concat(lieuxParDepartement.codeDepartements),
                    derniereMiseAJour: mergedLieuxParDepartement.derniereMiseAJour,
                    lieuxDisponibles: mergedLieuxParDepartement.lieuxDisponibles.concat(lieuxParDepartement.lieuxDisponibles),
                    lieuxIndisponibles: mergedLieuxParDepartement.lieuxIndisponibles.concat(lieuxParDepartement.lieuxIndisponibles),
                }), {
                    codeDepartements: [],
                    derniereMiseAJour: lieuxDepartement.derniereMiseAJour,
                    lieuxDisponibles: [],
                    lieuxIndisponibles: []
                } as LieuxParDepartement);

                this.lieuxParDepartementAffiches = this.afficherLieuxParDepartement(lieuxParDepartement, currentSearch);
                if(SearchRequest.isChronodoseType(this.currentSearch)) {
                    this.lieuxParDepartementAffiches.lieuxAffichables = this.lieuxParDepartementAffiches.lieuxAffichables.filter(l => {
                        return !l.appointment_by_phone_only
                    })
                }

                const commune = SearchRequest.isByCommune(currentSearch) ? currentSearch.commune : undefined
                Analytics.INSTANCE.rechercheLieuEffectuee(
                    codeDepartement,
                    this.currentCritereTri(),
                    currentSearch.type,
                    commune,
                    this.lieuxParDepartementAffiches);
            } finally {
                this.searchInProgress = false;
            }
        } else {
            this.lieuxParDepartementAffiches = undefined;
        }
    }

    private getStandardResultsLink() {
        if (this.currentSearch && SearchRequest.isByDepartement(this.currentSearch)) {
            return Router.getLinkToRendezVousAvecDepartement(this.currentSearch.departement.code_departement, libelleUrlPathDuDepartement(this.currentSearch.departement!), 'standard');
        }
        return ;
    }

    private prendreRdv(lieu: Lieu) {
        if(this.currentSearch && SearchRequest.isByCommune(this.currentSearch) && lieu.url) {
            Analytics.INSTANCE.clickSurRdv(lieu, this.currentCritereTri(), this.currentSearch.type, this.currentSearch.commune);
        }
        Router.navigateToUrlIfPossible(lieu.url);
    }

    private verifierRdv(lieu: Lieu) {
        if(this.currentSearch && SearchRequest.isByCommune(this.currentSearch) && lieu.url) {
            Analytics.INSTANCE.clickSurVerifRdv(lieu, this.currentCritereTri(), this.currentSearch.type, this.currentSearch.commune);
        }
        Router.navigateToUrlIfPossible(lieu.url);
    }

    renderAdditionnalSearchCriteria(): TemplateResult {
        return html``;
    }

    // FIXME move me to testable files
    protected extraireFormuleDeTri(lieu: LieuAffichableAvecDistance, tri: CodeTriCentre) {
        if(tri === 'date') {
            let firstLevelSort;
            if(lieu.appointment_by_phone_only && lieu.metadata.phone_number) {
                firstLevelSort = 2;
            } else if(lieu.url) {
                firstLevelSort = lieu.appointment_count !== 0 ? (lieu.prochain_rdv!==null? 0:1):3;
            } else {
                firstLevelSort = 4;
            }
            return `${firstLevelSort}__${Strings.padLeft(Date.parse(lieu.prochain_rdv!) || 0, 15, '0')}`;
        } else if(tri === 'distance') {
            let firstLevelSort;

            // Considering only 2 kind of sorting sections :
            // - the one with (potentially) available appointments (with url, or appointment by phone only)
            // - the one with unavailable appointments (without url, or with 0 available appointments)
            if(lieu.appointment_by_phone_only && lieu.metadata.phone_number) {
                firstLevelSort = 0;
            } else if(lieu.url) {
                firstLevelSort = lieu.appointment_count !== 0 ? 0:1;
            } else {
                firstLevelSort = 1;
            }

            return `${firstLevelSort}__${Strings.padLeft(Math.round(lieu.distance!*1000), 8, '0')}`;
        } else {
            throw new Error(`Unsupported tri : ${tri}`);
        }
    }

    protected updateSearchTypeTo(searchType: SearchType) {
        if(this.currentSearch) {
            this.goToNewSearch({
                ...this.currentSearch, type: searchType
            });
        }
    }

    protected transformLieuEnFonctionDuTypeDeRecherche(lieu: LieuAffichableAvecDistance) {
        if(SearchRequest.isChronodoseType(this.currentSearch)) {
            return {...lieu, appointment_count: ((!lieu.appointment_schedules?.length)?[]:lieu.appointment_schedules)?.find(s => s.name === 'chronodose')?.total || 0 };
        } else /* if(this.searchType === 'standard') */ {
            return lieu;
        }
    }

    abstract currentCritereTri(): CodeTriCentre;
    abstract libelleLieuSelectionne(): TemplateResult;
    // FIXME move me to a testable file
    abstract afficherLieuxParDepartement(lieuxParDepartement: LieuxParDepartement, search: SearchRequest): LieuxAvecDistanceParDepartement;
}

@customElement('vmd-rdv-par-commune')
export class VmdRdvParCommuneView extends AbstractVmdRdvView {
    @internalProperty() protected currentSearch: SearchRequest.ByCommune | void = undefined
    @property({type: String}) set searchType(type: SearchType) {
      this._searchType = type
      this.updateCurrentSearch()
    }
    @property({type: String}) set codeCommuneSelectionne(code: string) {
      this._codeCommuneSelectionne = code
      this.updateCurrentSearch()
    }
    @property({type: String}) set codePostalSelectionne (code: string) {
      this._codePostalSelectionne = code
      this.updateCurrentSearch()
    }
    @property({type: String}) set critèreDeTri (critèreDeTri: 'date' | 'distance') {
      this._critèreDeTri = critèreDeTri
      this.updateCurrentSearch()
    }

    @internalProperty() private _searchType: SearchType | undefined = undefined;
    @internalProperty() private _codeCommuneSelectionne: string | undefined = undefined;
    @internalProperty() private _codePostalSelectionne: string | undefined = undefined;
    @internalProperty() private _critèreDeTri: CodeTriCentre = 'distance'
    private currentSearchMarker = {}

    private async updateCurrentSearch() {
      if (this._codeCommuneSelectionne && this._codePostalSelectionne && this._critèreDeTri && this._searchType) {
        const marker = {}
        this.currentSearchMarker = marker
        await delay(20)
        if (this.currentSearchMarker !== marker) { return }
        const commune = await State.current.autocomplete.findCommune(this._codePostalSelectionne, this._codeCommuneSelectionne)
        if (commune) {
          this.currentSearch = SearchRequest.ByCommune(commune, this._critèreDeTri, this._searchType)
          this.refreshLieux()
        }
      }
    }

    codeDepartementAdditionnels(codeDepartementSelectionne: CodeDepartement) {
        return DEPARTEMENTS_LIMITROPHES[codeDepartementSelectionne];
    }

    libelleLieuSelectionne(): TemplateResult {
        let nom = '???'
        if (this.currentSearch) {
          const commune = this.currentSearch.commune
          nom = `${commune.nom} (${commune.codePostal})`
        }
        return html`
          autour de
          <span class="fw-bold">${nom}</span>
        `
    }

    // FIXME move me to testable file
    afficherLieuxParDepartement(lieuxParDepartement: LieuxParDepartement, search: SearchRequest.ByCommune): LieuxAvecDistanceParDepartement {
        const origin = search.commune
        const distanceAvec = (lieu: Lieu) => (lieu.location ? distanceEntreDeuxPoints(origin, lieu.location) : Infinity)


        const { lieuxDisponibles, lieuxIndisponibles } = lieuxParDepartement
        return {
            ...lieuxParDepartement,
            lieuxAffichables: ArrayBuilder.from([...lieuxDisponibles].map(l => ({...l, disponible: true})))
                .concat([...lieuxIndisponibles].map(l => ({...l, disponible: false})))
                .map(l => ({...l, distance: distanceAvec(l) }))
                .map(l => this.transformLieuEnFonctionDuTypeDeRecherche(l))
                .filter(l => !l.distance || l.distance < MAX_DISTANCE_CENTRE_IN_KM)
                .sortBy(l => this.extraireFormuleDeTri(l, search.tri))
                .filter((_, idx) => idx < MAX_CENTER_RESULTS_COUNT)
                .build()
        };
    }

    // FIXME move me to vmd-search)
    critereTriUpdated(triCentre: CodeTriCentre) {
        Analytics.INSTANCE.critereTriCentresMisAJour(triCentre);
        if (this.currentSearch) {
          const nextSearch = {
            ...this.currentSearch,
            tri: triCentre
          }
          this.goToNewSearch(nextSearch)
        }
    }
    protected beforeNewSearchFromLocation (search: SearchRequest): SearchRequest {
      if (SearchRequest.isByCommune(search) && this.currentSearch) {
        return {
          ...search,
          tri: this.currentSearch.tri
        }
      }
      return search
    }

    // FIXME move me to vmd-search
    renderAdditionnalSearchCriteria(): TemplateResult {
        if(SearchRequest.isStandardType(this.currentSearch)) {
            return html`
          <div class="rdvForm-fields row align-items-center">
            <label class="col-sm-24 col-md-auto mb-md-3">
              Je recherche une dose de vaccin :
            </label>
            <div class="col">
              <vmd-button-switch class="mb-3"
                     codeSelectionne="${this._critèreDeTri}"
                     .options="${Array.from(TRIS_CENTRE.values()).map(tc => ({code: tc.codeTriCentre, libelle: tc.libelle }))}"
                     @changed="${(event: ValueStrCustomEvent<CodeTriCentre>) => this.critereTriUpdated(event.detail.value)}">
              </vmd-button-switch>
            </div>
          </div>
        `;
        } else {
            return html``;
        }
    }

    protected updateSearchTypeTo(searchType: SearchType) {
        if(searchType === 'chronodose') {
            // This is pointless to sort by time in chronodrive search
            this.critèreDeTri = 'distance';
        }

        super.updateSearchTypeTo(searchType);
    }

    currentCritereTri(): CodeTriCentre {
        return this.critèreDeTri;
    }
}

@customElement('vmd-rdv-par-departement')
export class VmdRdvParDepartementView extends AbstractVmdRdvView {
    @property({type: String})
    set searchType (type: SearchType) {
      this._searchType = type
      this.updateCurrentSearch()
    }
    @property({type: String})
    set codeDepartementSelectionne (code: CodeDepartement) {
      this._codeDepartement = code
      this.updateCurrentSearch()
    }
    @internalProperty() private _searchType: SearchType | void = undefined
    @internalProperty() private _codeDepartement: CodeDepartement | void = undefined
    @internalProperty() protected currentSearch: SearchRequest.ByDepartement | void = undefined

    private async updateCurrentSearch() {
        const code = this._codeDepartement
        if (code && this._searchType) {
          const departements = await State.current.departementsDisponibles()
          const departementSelectionne = departements.find(d => d.code_departement === code);
          if (departementSelectionne) {
            this.currentSearch = SearchRequest.ByDepartement(departementSelectionne, this._searchType)
            this.refreshLieux()
          }
        }
    }

    codeDepartementAdditionnels () {
        return []
    }

    libelleLieuSelectionne(): TemplateResult {
        let nom = '???'
        if (this.currentSearch) {
          const departement = this.currentSearch.departement
          nom = `${departement.nom_departement} (${departement.code_departement})`
        }
        return html`
          för Region
          <span class="fw-bold">${nom}</span>
        `
    }

    // FIXME move me to testable file
    afficherLieuxParDepartement(lieuxParDepartement: LieuxParDepartement): LieuxAvecDistanceParDepartement {
        const { lieuxDisponibles, lieuxIndisponibles } = lieuxParDepartement

        return {
            ...lieuxParDepartement,
            lieuxAffichables: ArrayBuilder.from([...lieuxDisponibles].map(l => ({...l, disponible: true})))
                .concat([...lieuxIndisponibles].map(l => ({...l, disponible: false})))
                .map(l => ({...l, distance: undefined }))
                .map(l => this.transformLieuEnFonctionDuTypeDeRecherche(l))
                .sortBy(l => this.extraireFormuleDeTri(l, 'date'))
                .filter((_, idx) => idx < MAX_CENTER_RESULTS_COUNT)
                .build()
        };
    }

    currentCritereTri(): CodeTriCentre {
        return 'date';
    }
}
