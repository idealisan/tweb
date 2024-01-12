/*
 * https://github.com/morethanwords/tweb
 * Copyright (C) 2019-2021 Eduard Kuzmenko
 * https://github.com/morethanwords/tweb/blob/master/LICENSE
 */

import {Boost, PremiumBoostsStatus} from '../../../layer';
import {LangPackKey, i18n, join, joinElementsWith} from '../../../lib/langPack';
import Section from '../../section';
import {SliderSuperTabEventable} from '../../sliderTab';
import {Accessor, createRoot, createSignal, For} from 'solid-js';
import {render} from 'solid-js/web';
import Row from '../../row';
import {avatarNew, AvatarNew} from '../../avatarNew';
import LimitLine from '../../limit';
import {LoadableList, StatisticsOverviewItems, createLoadableList, createMoreButton, makeAbsStats} from './statistics';
import PopupBoostsViaGifts, {BoostsBadge} from '../../popups/boostsViaGifts';
import Button from '../../button';
import {attachClickEvent} from '../../../helpers/dom/clickEvent';
import PopupElement from '../../popups';
import {InviteLink} from '../../sidebarLeft/tabs/sharedFolder';
import {MTAppConfig} from '../../../lib/mtproto/appConfig';
import {horizontalMenu} from '../../horizontalMenu';
import classNames from '../../../helpers/string/classNames';
import {formatFullSentTime} from '../../../helpers/date';
import wrapPeerTitle from '../../wrappers/peerTitle';
import Icon from '../../icon';
import appDialogsManager from '../../../lib/appManagers/appDialogsManager';
import toggleDisability from '../../../helpers/dom/toggleDisability';
import findUpClassName from '../../../helpers/dom/findUpClassName';
import appImManager from '../../../lib/appManagers/appImManager';
import rootScope from '../../../lib/rootScope';

const getColorByMonths = (months: number) => {
  return months === 12 ? 'red' : (months === 3 ? 'green' : 'blue');
};

export default class AppBoostsTab extends SliderSuperTabEventable {
  private peerId: PeerId;
  private targets: Map<HTMLElement, Boost>;

  private _construct(
    boostsStatus: PremiumBoostsStatus,
    appConfig: MTAppConfig,
    boostsList: Accessor<LoadableList>,
    giftsBoostsList: Accessor<LoadableList>
  ) {
    const limitLine = new LimitLine({
      progress: true,
      hint: {
        icon: 'boost',
        noStartEnd: true
      }
    });

    const isMaxLevel = boostsStatus.next_level_boosts === undefined;
    const progress = isMaxLevel ?
      1 :
      (boostsStatus.boosts - boostsStatus.current_level_boosts) / (boostsStatus.next_level_boosts - boostsStatus.current_level_boosts);

    limitLine.setProgress(
      progress,
      '' + boostsStatus.boosts,
      {
        from1: i18n('BoostsLevel', [boostsStatus.level]),
        to1: i18n('BoostsLevel', [boostsStatus.level + 1]),
        from2: i18n('BoostsLevel', [boostsStatus.level]),
        to2: i18n('BoostsLevel', [boostsStatus.level + 1])
      }
    );

    limitLine._setHintActive();

    const url = boostsStatus.boost_url;

    const inviteLink = new InviteLink({
      listenerSetter: this.listenerSetter,
      url
    });

    const boostsViaGiftsButton = Button('btn-primary btn-transparent primary', {icon: 'gift_premium', text: 'BoostingGetBoostsViaGifts'});
    attachClickEvent(boostsViaGiftsButton, () => {
      PopupElement.createPopup(PopupBoostsViaGifts, this.peerId);
    }, {listenerSetter: this.listenerSetter});

    const noBoostersHint = i18n('NoBoostersHint');
    noBoostersHint.classList.add('boosts-no-boosters');

    let tabs: HTMLDivElement, content: HTMLDivElement;

    const MenuTab = (props: {
      key: LangPackKey,
      count: number
    }) => {
      return (
        <div class="menu-horizontal-div-item boosts-users-tab">
          <div class="menu-horizontal-div-item-span">
            {i18n(props.key, [props.count])}
            <i />
          </div>
        </div>
      );
    };

    const ContentTab = (props: {
      list: LoadableList,
      hide: boolean
    }) => {
      return (
        <div
          class={classNames('boosts-users-content', !props.list.count && 'is-empty', props.hide && 'hide')}
        >
          {props.list.count ? (
            <>
              {props.list.rendered}
              {props.list.loadMore && createMoreButton(
                props.list.count - props.list.rendered.length,
                (button) => {
                  const toggle = toggleDisability(button, true);
                  const promise = props.list.loadMore();
                  promise.finally(() => toggle());
                },
                this.listenerSetter
              )}
            </>
          ) : noBoostersHint}
        </div>
      );
    };

    const [tab, setTab] = createSignal(0);

    const ret = (
      <>
        <Section>
          {limitLine.container}
          <StatisticsOverviewItems items={[{
            title: 'BoostsLevel2',
            value: makeAbsStats(boostsStatus.level),
            includeZeroValue: true
          }, {
            title: 'PremiumSubscribers',
            value: boostsStatus.premium_audience,
            includeZeroValue: true,
            describePercentage: true
          }, {
            title: 'BoostsExisting',
            value: makeAbsStats(boostsStatus.boosts),
            includeZeroValue: true
          }, {
            title: 'BoostsToLevel',
            value: makeAbsStats(boostsStatus.next_level_boosts - boostsStatus.boosts)
          }]} />
        </Section>
        {boostsStatus.prepaid_giveaways?.length && (
          <Section name="Giveaway.Prepaid" nameArgs={[1]} caption="BoostingSelectPaidGiveaway">
            <For each={boostsStatus.prepaid_giveaways}>{(prepaidGiveaway) => {
              const {quantity, months} = prepaidGiveaway;
              const row = new Row({
                titleLangKey: 'BoostingGiveawayMsgInfoPlural1',
                titleLangArgs: [quantity],
                subtitleLangKey: 'Giveaway.Prepaid.Subtitle',
                subtitleLangArgs: [quantity, i18n('Giveaway.Prepaid.Period', [months])],
                clickable: () => {},
                listenerSetter: this.listenerSetter,
                rightContent: BoostsBadge({boosts: (appConfig.giveaway_boosts_per_premium || 1) * quantity}) as HTMLElement
              });

              row.title.classList.add('text-bold');
              const media = row.createMedia('abitbigger');
              const avatar = AvatarNew({size: 42});
              avatar.set({icon: 'gift_premium', color: getColorByMonths(months)});
              media.append(avatar.node);

              return row.container;
            }}</For>
          </Section>
        )}
        <Section class="boosts-users-container">
          <div ref={tabs} class="menu-horizontal-div boosts-users-tabs">
            <MenuTab key="BoostingBoostsCount" count={boostsList().count} />
            {giftsBoostsList().count && <MenuTab key="BoostingGiftsCount" count={giftsBoostsList().count} />}
          </div>
          <div ref={content} class="boosts-users-contents" onClick={(e) => {
            const target = findUpClassName(e.target, 'row');
            const boost = this.targets.get(target);
            if(!boost) {
              return;
            }

            if(tab() === 0) {
              appImManager.setInnerPeer({peerId: boost.user_id.toPeerId(false)});
            } else {

            }
          }}>
            <ContentTab list={boostsList()} hide={tab() !== 0} />
            {giftsBoostsList().count && <ContentTab list={giftsBoostsList()} hide={tab() !== 1} />}
          </div>
        </Section>
        <Section name="LinkForBoosting" caption="BoostingShareThisLink">
          {inviteLink.container}
        </Section>
        <Section caption="BoostingGetMoreBoosts">
          {boostsViaGiftsButton}
        </Section>
      </>
    );

    const selectTab = horizontalMenu(tabs, content, (index) => {
      setTab(index);
    }, undefined, undefined, undefined, this.listenerSetter);
    selectTab(tab());

    return ret;
  }

  private renderBoost = async(boost: Boost) => {
    console.log(boost);
    const boosts = 1 * (boost.multiplier || 1);
    const days = (boost.expires - boost.date) / 86400;
    const months = Math.round(days / 30);
    let peerId = boost.user_id?.toPeerId(false);
    if(peerId === rootScope.myId) {
      peerId = undefined;
    }

    let badge: HTMLElement;
    if(boosts > 1) {
      badge = document.createElement('span');
      badge.classList.add('boosts-user-boosts', 'boosts-user-badge');
      badge.append(Icon('boost'), ` ${boosts}`);
    }

    let title: HTMLElement;
    if(peerId) {
      title = await wrapPeerTitle({peerId});
      title.classList.add('boosts-user-name');
    } else {
      title = i18n(boost.pFlags.unclaimed ? 'BoostingUnclaimed' : 'BoostingToBeDistributed');
    }

    let subtitle: HTMLElement;
    if(peerId) {
      subtitle = i18n('BoostsExpiration', [boosts, formatFullSentTime(boost.expires)]);
    } else {
      subtitle = document.createElement('span');
      subtitle.append(
        ...joinElementsWith([
          i18n('BoostingShortMonths', [months]),
          formatFullSentTime(boost.expires, undefined, true)
        ], ' • ')
      );
    }

    let rightContent: HTMLElement;
    if(boost.pFlags.giveaway || boost.pFlags.gift) {
      rightContent = document.createElement('span');
      rightContent.classList.add('boosts-user-badge-right', 'boosts-user-badge');
      rightContent.append(
        Icon(boost.pFlags.giveaway ? 'gift_premium' : 'gift'),
        i18n(boost.pFlags.giveaway ? 'BoostingGiveaway' : 'BoostingGift')
      );

      rightContent.classList.toggle('is-gift', !boost.pFlags.giveaway && !!boost.pFlags.gift);
    }

    const row = new Row({
      title: true,
      subtitle,
      clickable: true,
      noWrap: true,
      rightContent
    });

    if(peerId) {
      row.container.dataset.peerId = '' + peerId;
    }

    row.title.classList.add('boosts-user-title');
    row.title.append(...[title, badge].filter(Boolean));
    const media = row.createMedia('abitbigger');
    const avatar = avatarNew({
      peerId,
      size: 42,
      middleware: this.middlewareHelper.get()
    });
    media.append(avatar.node);

    if(peerId) {
      await avatar.readyThumbPromise;
    } else {
      avatar.set({
        icon: boost.pFlags.unclaimed ? 'deleteuser' : 'noncontacts',
        color: getColorByMonths(months)
      });
    }

    this.targets.set(row.container, boost);
    return row.container;
  };

  public async init(peerId: PeerId) {
    this.container.classList.add('boosts-container');

    this.peerId = peerId;
    this.targets = new Map();

    this.setTitle('Boosts');

    const createLoader = (gifts?: boolean) => {
      const middleware = this.middlewareHelper.get();
      let offset = '', isFirst = true;
      const loadMore = async() => {
        const limit = isFirst ? 20 : 100;
        isFirst = false;
        const boostsList = await this.managers.appBoostsManager.getBoostsList({peerId, offset, limit, gifts});
        if(!middleware()) return;

        console.log(boostsList, gifts);

        const promises = boostsList.boosts.map(this.renderBoost);
        const rendered = await Promise.all(promises);

        setF((value) => {
          value.count = boostsList.count;
          offset = boostsList.next_offset;
          if(!offset) {
            value.loadMore = undefined;
          }

          value.rendered.push(...rendered);
          return value;
        });
      };

      const [f, setF] = createLoadableList({loadMore});
      return f;
    };

    const [boostsList, giftsBoostsList] = createRoot((dispose) => {
      const middleware = this.middlewareHelper.get();
      middleware.onDestroy(dispose);
      return [createLoader(false), createLoader(true)]
    });

    const [boostsStatus, appConfig, _, __] = await Promise.all([
      this.managers.appBoostsManager.getBoostsStatus(peerId),
      this.managers.apiManager.getAppConfig(),
      boostsList().loadMore(),
      giftsBoostsList().loadMore()
    ]);

    const div = document.createElement('div');
    this.scrollable.append(div);
    const dispose = render(() => this._construct(boostsStatus, appConfig, boostsList, giftsBoostsList), div);
    this.eventListener.addEventListener('destroy', dispose);
  }
}
