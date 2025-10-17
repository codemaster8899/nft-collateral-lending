import { useCallback, useMemo } from 'react';

import router from 'next/router';
import { SubmitHandler } from 'react-hook-form';
import { InView } from 'react-intersection-observer';
import { useAccount } from 'wagmi';

import MoreIcon from '@/assets/icons/elipses.svg';
import { Loader } from '@/components/Loader';
import NumberWithTooltip from '@/components/shared/tooltips/NumberTooltip';
import { useMakeBorrowRequest } from '@/hooks/query/loans/useMakeBorrowRequest';
import { useAppDispatch, useAppSelector } from '@/hooks/redux';
import { changeReqLoans, changeQuickReqLoans, deleteNFTsFromBorrower, fetchNFTs, selectLoans } from '@/redux/loans/loansSlice';
import { ILoanNFT } from '@/redux/loans/model';
import { customFixed } from '@/utils/formatter';
import { IDesiredTerms, TLoanTableHeaders } from 'types/loan';

import LoanFormModal from './LoanFormModal';
import LoanGridItemView from './LoanGridItemView';
import QuickLoanModal from './quick-loan/QuickLoanModal';
import TraitColumn from './TraitColumn';
import CryptoHeadButton from '../crypto-prices/CryptoHeadButton';
import TableUi from '../top-sales/TableUi';

const cryptoColumns: TLoanTableHeaders = [
  {
    Header: (props) => <CryptoHeadButton columnName='Asset' {...props} />,
    accessor: 'name',
    disableSortBy: true,
  },
  {
    Header: (props) => <CryptoHeadButton columnName='Floor' {...props} />,
    accessor: 'floor',
    disableSortBy: true,
    thPClassName: 'mx-auto',
    thClassName: 'w-28 px-2',
  },
  {
    Header: (props) => <CryptoHeadButton columnName='Trait' {...props} />,
    accessor: 'trait',
    disableSortBy: true,
    thPClassName: 'mx-auto',
    thClassName: 'w-28 px-2',
  },
  {
    Header: (props) => <CryptoHeadButton columnName='Rarity' {...props} />,
    accessor: 'rarity',
    disableSortBy: true,
    thPClassName: 'mx-auto',
    thClassName: 'w-28 px-2',
  },
  {
    accessor: 'borrow',
    disableSortBy: true,
    thPClassName: 'mx-auto',
    thClassName: 'w-[98px] px-2',
  },
  {
    accessor: 'more',
    thClassName: 'w-[10px]',
  },
];

const filterKeys = {
  name: {
    ASC: 'transfer_time__asc',
    DESC: 'transfer_time__desc',
  },
  floor: {
    ASC: 'floor_price__asc',
    DESC: 'floor_price__desc',
  },
};

type SortKeys = 'name' | 'floor';
type SortDir = 'ASC' | 'DESC';

const BorrowLoan: React.FC = () => {
  const sort = ((Array.isArray(router.query.sort) ? router.query.sort[0] : router.query.sort) as SortKeys) || 'name';
  const dir = ((Array.isArray(router.query.dir) ? router.query.dir[0] : router.query.dir) as SortDir) || 'DESC';
  const { searchTerm } = router.query;
  const { NFTsPagination, loading } = useAppSelector((state) => state.loans);
  const { loanCardView } = useAppSelector((state) => state.loans);
  const dispatch = useAppDispatch();
  const { requestedLoan, isQuickLoanModalOpen, requestedQuickLoan } = useAppSelector(selectLoans);

  const { address } = useAccount();
  const checkedTr = useCallback(
    (tokenId: number) => {
      return requestedLoan?.uniqueId === tokenId;
    },
    [requestedLoan]
  );

  const handleCheckboxChange = useCallback(
    (token: ILoanNFT) => {
      if (!token) return;
      const isRequested = checkedTr(token.uniqueId);

      if (isRequested) {
        dispatch(changeReqLoans(null));
      } else {
        dispatch(changeReqLoans(token));
      }
    },

    [checkedTr, dispatch]
  );

  const fetchData = useCallback(() => {
    if (!address) return;
    const orderBy = filterKeys[sort]?.[dir] || filterKeys.floor.DESC;
    dispatch(fetchNFTs({ walletAddress: address, order_by: orderBy, collectionSearch: searchTerm }));
  }, [address, dispatch, sort, dir, searchTerm]);

  const tokens = NFTsPagination?.NFTs;

  const tableData = useMemo(() => {
    if (!tokens) return null;

    return tokens.map((token) => {
      const { id, name: collectionName, collection_logo, floor_price: floorPrice, rarity_rank: rarityRank, normalized_metadata, raritySimplehash, token_address, token_id } = token;

      return {
        id,
        name: (
          <div className='flex gap-[14px] pl-6 pr-1 w-max items-center'>
            <img
              src={normalized_metadata?.image || '/bayc-collectors.png'}
              onError={(e) => {
                if (e.currentTarget.src === normalized_metadata?.image) {
                  e.currentTarget.src = collection_logo || '/bayc-collectors.png';
                } else if (e.currentTarget.src === collection_logo) {
                  e.currentTarget.src = '/bayc-collectors.png';
                }
              }}
              className='size-9 rounded object-cover'
              alt='loan image'
            />
            <div className='flex flex-col w-max'>
              <p className='w-max font-medium text-base leading-normal'>{collectionName}</p>
              <p className='w-max font-normal text-xs leading-normal'># {normalized_metadata?.name || token_id}</p>
            </div>
          </div>
        ),
        floor: (
          <NumberWithTooltip fullNumber={floorPrice || 'N/A'} symbol={floorPrice ? 'WETH' : ''} wrapperClassName='w-full'>
            <p className='text-sm font-normal font-space-mono w-max mx-auto'>{floorPrice ? `${customFixed(Number(floorPrice))} WETH` : 'N/A'}</p>
          </NumberWithTooltip>
        ),
        trait: <TraitColumn contractAddress={token_address} tokenId={token_id} />,
        rarity: (
          <NumberWithTooltip fullNumber={raritySimplehash.rank || rarityRank || 'N/A'} symbol='' wrapperClassName='w-full'>
            <p className='text-sm font-normal font-space-mono w-max mx-auto'>{raritySimplehash.rank || rarityRank || 'N/A'}</p>
          </NumberWithTooltip>
        ),
        borrow: (
          <button
            onClick={() => {
              dispatch(changeReqLoans(token));
            }}
            className='bg-primary py-3 px-[22px] rounded text-xs font-semibold text-white'
          >
            Borrow
          </button>
        ),
        more: (
          <button className='w-[3px] h-3 mr-4 !bg-transparent ml-4'>
            <MoreIcon className='[&_path]:fill-coal-250' />
          </button>
        ),
        collection_id: token,
      };
    });
  }, [tokens, dispatch]);

  const fetchNextPage = (inView: boolean) => {
    if (!inView) return;
    fetchData();
  };

  const { makeBorrowRequest } = useMakeBorrowRequest(
    requestedQuickLoan
      ? {
          id: requestedQuickLoan.tokenId,
          contractAddress: requestedQuickLoan?.contract.address,
          collection: { name: requestedQuickLoan?.contract.openSeaMetadata.collectionName },
          imageUrl: requestedQuickLoan?.image.originalUrl,
          name: requestedQuickLoan?.name,
        }
      : requestedLoan
        ? {
            id: requestedLoan.token_id,
            contractAddress: requestedLoan?.token_address,
            collection: { name: requestedLoan?.name },
            imageUrl: requestedLoan?.normalized_metadata.image,
            name: requestedLoan?.normalized_metadata.name,
          }
        : null
  );

  const requestLoan: SubmitHandler<
    IDesiredTerms & {
      termUnix?: number;
    }
  > = async (terms) => {
    await makeBorrowRequest(terms);
    dispatch(deleteNFTsFromBorrower());
    dispatch(changeReqLoans(null));
    dispatch(changeQuickReqLoans(null));
  };

  const handleClose = () => {
    dispatch(changeReqLoans(null));
  };

  return (
    <>
      <div className='overflow-x-auto custom-scrollbar hidden h-full lg:block pb-20'>
        {tableData && (
          <>
            {loanCardView === 'card' ? (
              <div className='grid [grid-template-columns:repeat(auto-fill,minmax(236px,1fr))] border-y'>
                {tokens.map((token) => {
                  const {
                    id,
                    name,
                    floor_price: floorPrice,
                    normalized_metadata: { image: image_url },
                    token_address,
                    rarity_rank: rarityRank,
                    raritySimplehash,
                    token_id,
                  } = token;

                  const loanDetails = [
                    {
                      label: 'Floor',
                      value: floorPrice ? customFixed(Number(floorPrice), 4, false) : 'N/A',
                      symbol: floorPrice ? 'WETH' : '',
                    },
                    {
                      label: 'Trait',
                      value: (
                        <div className='text-xs'>
                          <span className='text-medium'>Trait</span>
                          <TraitColumn contractAddress={token_address} tokenId={token_id} textClassName='text-xs' />
                        </div>
                      ),
                      className: 'items-end',
                    },
                    {
                      label: 'Rarity',
                      value: raritySimplehash.rank || rarityRank || 'N/A',
                      className: 'items-end',
                    },
                  ];
                  return <LoanGridItemView key={id} handleAction={() => dispatch(changeReqLoans(token))} name={name} id={id} loanDetails={loanDetails} image={image_url} />;
                })}
              </div>
            ) : (
              <TableUi wrapperStyle='pb-20' enableDefaultSort checkedTr={checkedTr} columns={cryptoColumns} data={tableData} loading={false} hoverClass='border-[2px] !border-primary h-[80px] dark:hover:!bg-jet-black-100 hover:!bg-light-blue-grey' handleNavigateDetails={(token) => handleCheckboxChange(token)} />
            )}
            {!loading ? !!NFTsPagination?.next.length && <InView onChange={fetchNextPage} /> : <Loader />}
          </>
        )}
      </div>
      {isQuickLoanModalOpen && <QuickLoanModal onSubmit={requestLoan} />}
      {requestedLoan && <LoanFormModal name={requestedLoan.normalized_metadata.name} collectionAddress={requestedLoan.token_address} handleClose={handleClose} collectionName={requestedLoan.name} last_sale={requestedLoan.last_sale} floorPrice={Number(requestedLoan.floor_price)} imageUrl={requestedLoan.normalized_metadata.image} onSubmit={requestLoan} tokenId={requestedLoan.token_id} />}
    </>
  );
};

export default BorrowLoan;
