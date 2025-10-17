const { default: axios } = require("axios");
const { OPENSEA_CHAIN } = require("./constants");

const headers = {
  "X-API-KEY": process.env.OPENSEA_API_KEY,
  accept: "application/json",
};

const url = `https://${
  OPENSEA_CHAIN === "sepolia" ? "testnets-" : ""
}api.opensea.io/api/v2`;

const postOpensea = async (path, body) => {
  const { data } = await axios.post(`${url}${path}`, body, {
    headers: headers,
  });

  return data;
};

const getOpensea = async (path, params) => {
  const { data } = await axios.get(`${url}${path}`, {
    headers: headers,
    params,
  });

  return data;
};
exports.getCollectionOffers = async (collectionSlug, params) => {
  try {
    return await getOpensea(`/offers/collection/${collectionSlug}`, params);
  } catch (e) {
    if (e.response.status === 409) {
      throw new Error(429);
    }

    return {};
  }
};

exports.refreshNFTMetadata = ({ tokenId, contractAddress }) => {
  return postOpensea(
    `/chain/${OPENSEA_CHAIN}/contract/${contractAddress}/nfts/${tokenId}/refresh`
  );
};

exports.getTraitBestPrice = async (contractAddress, tokenId) => {
  const myHeaders = new Headers();
  myHeaders.append("content-type", "application/json");
  myHeaders.append(
    "user-agent",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
  );
  myHeaders.append(
    "User-Agent",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
  );

  const graphql = JSON.stringify({
    query:
      "query ItemAttributesQuery($identifier: ItemIdentifierInput!) {\n  itemByIdentifier(identifier: $identifier) {\n    __typename\n    ... on Item {\n      id\n      attributes {\n        traitType\n        value\n        __typename\n      }\n      ...ItemAttributesGrid\n      ...ItemAttributesTable\n      __typename\n    }\n  }\n}\nfragment ItemAttributesGrid on Item {\n  id\n  collection {\n    id\n    slug\n    __typename\n  }\n  attributes {\n    traitType\n    value\n    floorPrice {\n      native {\n        unit\n        __typename\n      }\n      ...TokenPrice\n      __typename\n    }\n    stats {\n      itemCount\n      percent\n      __typename\n    }\n    __typename\n  }\n  __typename\n}\nfragment TokenPrice on Price {\n  usd\n  token {\n    unit\n    symbol\n    contractAddress\n    chain {\n      identifier\n      __typename\n    }\n    __typename\n  }\n  __typename\n}\nfragment ItemAttributesTable on Item {\n  attributes {\n    traitType\n    value\n    __typename\n  }\n  ...ItemAttributesTableRow\n  __typename\n}\nfragment ItemAttributesTableRow on Item {\n  attributes {\n    traitType\n    value\n    floorPrice {\n      native {\n        unit\n        __typename\n      }\n      ...TokenPrice\n      __typename\n    }\n    topOfferPrice {\n      native {\n        unit\n        __typename\n      }\n      ...TokenPrice\n      __typename\n    }\n    stats {\n      itemCount\n      percent\n      __typename\n    }\n    __typename\n  }\n  collection {\n    slug\n    __typename\n  }\n  __typename\n}",
    variables: {
      identifier: {
        chain: OPENSEA_CHAIN,
        contractAddress,
        tokenId,
      },
    },
  });
  const requestOptions = {
    method: "POST",
    headers: myHeaders,
    body: graphql,
    redirect: "follow",
  };

  const result = await fetch(
    "https://gql.opensea.io/graphql",
    requestOptions
  ).then((response) => response.json());

  const maxTraitPrice = result.data.itemByIdentifier.attributes.reduce(
    (agg, item) => {
      if (item.floorPrice && item.floorPrice.native.unit > agg) {
        return item.floorPrice.native.unit;
      }
      return agg;
    },
    0
  );

  return maxTraitPrice;
};
