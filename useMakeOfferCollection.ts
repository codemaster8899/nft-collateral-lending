import { useParams } from 'next/navigation';
import { SubmitHandler } from 'react-hook-form';
import toast from 'react-hot-toast';
import { useAccount, useSignMessage } from 'wagmi';

import { makeLoanOffer } from '@/api/loans';
import { checkERC20Balance } from '@/utils/checkERC20Balance';
import { convertValueToWei } from '@/utils/convertValueToWei';
import { encodeAbi } from '@/utils/encodeAbi';
import { getContractDecimals } from '@/utils/getContractDecimals';
import { generateUniqueNumber } from '@/utils/helper';
import { convertDayToUnix } from '@/utils/unixTimestamp';
import { vaultAddress } from 'smart-contracts/addresses';
import { useErc20Contract } from 'smart-contracts/contracts';
import { IDesiredTerms } from 'types/loan';

import { useCollectionDetails } from './query/loans/useCollectionDetails';
import useCollectionLoan from './query/loans/useCollectionLoan';
import useAuthenticate from './useAuthenticate';

const useMakeOfferCollection = () => {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const params = useParams();
  const paramsCollectionAddress = params?.address;
  const { refetch } = useCollectionLoan(paramsCollectionAddress);
  const generateErc20Contract = useErc20Contract();
  const collectionMethods = useCollectionDetails();
  const selectedCollection = collectionMethods.data;
  const { isAuth } = useAuthenticate();

  const makeOfferCollection: SubmitHandler<IDesiredTerms & { termUnix?: number }> = async ({ apr, principal, ltv, repay, term, interestRate, termUnix: defaultTermUnix, exp, currency }) => {
    try {
      if (!isAuth) {
        toast.error('Login to submit an offer.');
        return;
      }

      if (!address) {
        toast.error('Connect your wallet to submit an offer.');
        return;
      }
      if (!selectedCollection) return;
      const erc20Contract = generateErc20Contract(currency);

      if (!erc20Contract) return;
      const decimals = await getContractDecimals(erc20Contract);
      const loanAmount = convertValueToWei(principal, decimals);
      if (!(await checkERC20Balance(erc20Contract, address, loanAmount, 'You do not have enough funds to make a collection offer'))) return;
      const [allowFunds] = await erc20Contract.functions.allowance(address, vaultAddress);
      if (allowFunds.lt(loanAmount)) {
        await erc20Contract.functions.approve(vaultAddress, loanAmount).then(({ wait }) => wait());
      }
      const termUnix = defaultTermUnix || convertDayToUnix(term);
      const nonce = generateUniqueNumber();
      const { address: collectionAddress } = selectedCollection;

      const payload = {
        collectionAddress: {
          type: 'address',
          value: collectionAddress,
        },
        erc20TokenAddress: {
          type: 'address',
          value: currency,
        },
        lender: {
          type: 'address',
          value: address,
        },
        loanAmount: {
          type: 'uint256',
          value: loanAmount,
        },
        aprBasisPoints: {
          type: 'uint256',
          value: apr * 100,
        },
        loanDuration: {
          type: 'uint256',
          value: termUnix,
        },
        nonce: {
          type: 'uint256',
          value: nonce,
        },
      } as const;

      const hash = encodeAbi(payload);
      const signature = await signMessageAsync({
        message: { raw: hash },
      });

      await makeLoanOffer({
        collectionAddress,
        apr,
        currency,
        nonce,
        principal,
        repay,
        signature,
        term,
        termUnix,
        collectionId: collectionAddress,
        collectionName: selectedCollection.name,
        lenderAddress: address,
        interestRate,
        collectionMarketplaceId: selectedCollection.address,
        expDuration: exp,
        realCollectionId: selectedCollection.address,
        ltv,
      });
      if (paramsCollectionAddress) {
        refetch();
      }
      toast.success('The collection offer has been successfully created.');
    } catch (e: any) {
      if (e.code === 4001) {
        toast.error('Offer Canceled');
      } else {
        toast.error(e.toString());
      }
    }
  };

  return { makeOfferCollection, collectionMethods };
};

export default useMakeOfferCollection;
